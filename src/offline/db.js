// src/offline/db.js  — P2 + P3 + P4 + FIX-TRANSACTION + parent_id-EXPORT + MUTEX
//
// CHANGES FROM PREVIOUS VERSION:
//
//   MUTEX ADDED — replaceAllChunksWithVectors() now uses a serial queue so
//                only one full replacement runs at any moment. Fixes the
//                "cannot start a transaction within a transaction" error
//                when two sync triggers overlap.
//
//   KEPT — All previous changes: parent_id column, manual BEGIN/COMMIT/ROLLBACK,
//          P4 hybrid search, logging, etc.

import * as SQLite     from 'expo-sqlite';
import * as FileSystem from 'expo-file-system/legacy';
import { Platform }    from 'react-native';
import { createLogger } from '../utils/logger';

const log = createLogger('db');

// ─────────────────────────────────────────────────────────────
// BLOB HELPER
// ─────────────────────────────────────────────────────────────

function toVecBlob(embedding) {
  if (embedding instanceof Uint8Array) {
    log.debug('toVecBlob() — input is already Uint8Array');
    return embedding;
  }
  if (embedding instanceof Float32Array) {
    log.debug('toVecBlob() — converting Float32Array → Uint8Array');
    return new Uint8Array(embedding.buffer);
  }
  log.debug('toVecBlob() — converting plain number[] → Float32Array → Uint8Array');
  return new Uint8Array(new Float32Array(embedding).buffer);
}

// ─────────────────────────────────────────────────────────────
// DB SINGLETON
// ─────────────────────────────────────────────────────────────

let _db     = null;
let _dbInit = null;

async function getDb() {
  if (_db) return _db;
  if (!_dbInit) {
    log.info('getDb() — no DB open yet, starting _initDb()');
    _dbInit = _initDb().catch(err => {
      log.error('getDb() _initDb() FAILED:', err.message);
      _dbInit = null;
      _db     = null;
      throw err;
    });
  } else {
    log.debug('getDb() — _initDb() already in progress, awaiting …');
  }
  return _dbInit;
}

async function _initDb() {
  log.info('_initDb() — opening rag_offline.db …');
  const startMs = Date.now();

  const db = await SQLite.openDatabaseAsync('rag_offline.db');
  log.info('_initDb() DB opened in', Date.now() - startMs, 'ms');

  await db.execAsync('PRAGMA journal_mode = WAL;');
  log.debug('_initDb() WAL journal mode set');

  // ── Load sqlite-vec extension ──────────────────────
  try {
    const libName = Platform.OS === 'android' ? 'vec0' : 'vec0.dylib';
    log.info('_initDb() loading sqlite-vec extension:', libName);
    await db.loadExtensionAsync(libName);
    log.info('_initDb() ✅ sqlite-vec extension loaded');
  } catch (e) {
    log.warn('_initDb() ⚠ sqlite-vec not available — BM25-only fallback:', e.message);
  }

  // ── Schema ────────────────────────────────────────
  log.debug('_initDb() creating schema …');
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS chunks (
      id             TEXT    PRIMARY KEY,
      source         TEXT    NOT NULL DEFAULT '',
      content        TEXT    NOT NULL DEFAULT '',
      parent_content TEXT    NOT NULL DEFAULT '',
      parent_id      TEXT    NOT NULL DEFAULT '',   -- NEW
      page           INTEGER NOT NULL DEFAULT 0,
      chunk_type     TEXT    NOT NULL DEFAULT 'text',
      section_path   TEXT    NOT NULL DEFAULT '',
      heading        TEXT    NOT NULL DEFAULT '',
      bbox           TEXT    DEFAULT NULL,
      page_width     REAL    DEFAULT NULL,
      page_height    REAL    DEFAULT NULL,
      synced_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      id             UNINDEXED,
      content,
      parent_content,
      source         UNINDEXED,
      tokenize = 'porter unicode61'
    );

    CREATE TABLE IF NOT EXISTS sync_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  log.debug('_initDb() main schema ready');

  // Migrate existing installs: add parent_id if missing
  try {
    await db.execAsync('ALTER TABLE chunks ADD COLUMN parent_id TEXT NOT NULL DEFAULT \'\';');
    log.debug('_initDb() added parent_id column (or already existed)');
  } catch (_) {
    // column already exists — safe to ignore
  }

  // vec_chunks — requires extension already loaded
  try {
    await db.execAsync(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
        id        TEXT PRIMARY KEY,
        embedding FLOAT[384]
      );
    `);
    log.info('_initDb() ✅ vec_chunks table ready');
  } catch (e) {
    log.warn('_initDb() ⚠ vec_chunks table not created (extension missing?):', e.message);
  }

  _db = db;
  log.info('_initDb() COMPLETE — DB fully initialised in', Date.now() - startMs, 'ms');
  return _db;
}

// ─────────────────────────────────────────────────────────────
// MUTEX – serialises replaceAllChunksWithVectors() calls
// ─────────────────────────────────────────────────────────────

let _replaceMutex = Promise.resolve();

function withMutex(fn) {
  const prev = _replaceMutex;
  let release;
  _replaceMutex = new Promise(resolve => { release = resolve; });
  return prev.then(() => fn()).finally(release);
}

// ─────────────────────────────────────────────────────────────
// CHUNK OPERATIONS — REPLACE WITH VECTORS (mutex-guarded)
// ─────────────────────────────────────────────────────────────

export async function replaceAllChunksWithVectors(chunks) {
  return withMutex(() => _replaceAllChunksWithVectors(chunks));
}

async function _replaceAllChunksWithVectors(chunks) {
  log.info('replaceAllChunksWithVectors() START — received', chunks.length, 'chunks');
  const startMs = Date.now();

  const db = await getDb();
  let vectorCount       = 0;
  let vectorErrors      = 0;
  let duplicatesSkipped = 0;

  // Deduplicate by id BEFORE the transaction.
  log.debug('replaceAllChunksWithVectors() deduplicating chunks …');
  const seen   = new Set();
  const unique = [];
  for (const c of chunks) {
    const id = c.id || `${c.source}_${c.page ?? 0}_${Math.random().toString(36).slice(2)}`;
    if (seen.has(id)) {
      duplicatesSkipped++;
      log.warn(`replaceAllChunksWithVectors() duplicate chunk id skipped: ${id}`,
        `(source=${c.source} page=${c.page})`);
      continue;
    }
    seen.add(id);
    unique.push({ ...c, _resolvedId: id });
  }

  if (duplicatesSkipped > 0) {
    log.warn(`replaceAllChunksWithVectors() deduplication: ${duplicatesSkipped} duplicate(s) dropped`);
  }
  log.info('replaceAllChunksWithVectors() writing', unique.length, 'unique chunks …');

  // FIX: manual transaction
  try {
    log.debug('replaceAllChunksWithVectors() BEGIN transaction');
    await db.runAsync('BEGIN;');

    // Clear existing data
    await db.runAsync('DELETE FROM chunks;');
    await db.runAsync('DELETE FROM chunks_fts;');
    log.debug('replaceAllChunksWithVectors() cleared chunks + FTS tables');

    try {
      await db.runAsync('DELETE FROM vec_chunks;');
      log.debug('replaceAllChunksWithVectors() cleared vec_chunks table');
    } catch (e) {
      log.warn('replaceAllChunksWithVectors() vec_chunks DELETE skipped (extension not loaded?):', e.message);
    }

    // Insert each chunk
    for (let i = 0; i < unique.length; i++) {
      const c        = unique[i];
      const id       = c._resolvedId;
      const bboxJson = Array.isArray(c.bbox) ? JSON.stringify(c.bbox) : null;

      if (i % 100 === 0 && i > 0) {
        log.debug(`replaceAllChunksWithVectors() progress: ${i}/${unique.length} chunks inserted`);
      }

      // 1. Main chunks table (now includes parent_id)
      await db.runAsync(
        `INSERT OR REPLACE INTO chunks
           (id, source, content, parent_content, parent_id, page, chunk_type,
            section_path, heading, bbox, page_width, page_height)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          c.source         || '',
          c.content        || '',
          c.parent_content || c.content || '',
          c.parent_id      || '',                 // NEW
          c.page           ?? 0,
          c.chunk_type     || 'text',
          c.section_path   || '',
          c.heading        || '',
          bboxJson,
          c.page_width     ?? null,
          c.page_height    ?? null,
        ],
      );

      // 2. FTS5 index
      await db.runAsync(
        'INSERT INTO chunks_fts (id, content, parent_content, source) VALUES (?, ?, ?, ?)',
        [id, c.content || '', c.parent_content || c.content || '', c.source || ''],
      );

      // 3. Vector index
      if (!c.embedding || !Array.isArray(c.embedding) || c.embedding.length === 0) {
        continue;
      }
      if (c.embedding.length !== 384) {
        log.warn(`replaceAllChunksWithVectors() wrong embedding dim for ${id}:`,
          c.embedding.length, '(expected 384) — skipping vector insert');
        vectorErrors++;
        continue;
      }

      try {
        const blob = toVecBlob(c.embedding);
        await db.runAsync(
          'INSERT OR IGNORE INTO vec_chunks (id, embedding) VALUES (?, ?)',
          [id, blob],
        );
        vectorCount++;
      } catch (e) {
        log.error(`replaceAllChunksWithVectors() vec insert FAILED for chunk ${id}:`, e.message);
        vectorErrors++;
      }
    }

    await db.runAsync('COMMIT;');
    log.info('replaceAllChunksWithVectors() COMMIT — transaction complete');

  } catch (err) {
    log.error('replaceAllChunksWithVectors() ERROR inside transaction — rolling back:', err.message);
    try { await db.runAsync('ROLLBACK;'); } catch (_) {
      log.error('replaceAllChunksWithVectors() ROLLBACK also failed — DB may be in bad state');
    }
    throw err;
  }

  const elapsed = Date.now() - startMs;

  if (vectorErrors > 0) {
    log.warn(
      `replaceAllChunksWithVectors() DONE in ${elapsed}ms —`,
      `${unique.length} chunks, ${vectorCount} vectors`,
      `(${vectorErrors} vec errors, ${duplicatesSkipped} duplicates dropped)`,
    );
  } else {
    log.info(
      `replaceAllChunksWithVectors() ✅ DONE in ${elapsed}ms —`,
      `${unique.length} chunks, ${vectorCount} vectors`,
      duplicatesSkipped > 0 ? `(${duplicatesSkipped} duplicates dropped)` : '',
    );
  }
}

export const replaceAllChunks = replaceAllChunksWithVectors;

// ─────────────────────────────────────────────────────────────
// HYBRID SEARCH — BM25 + KNN + RRF
// ─────────────────────────────────────────────────────────────

const RRF_K = 60;

function rrfMerge(resultLists, topK) {
  log.debug('rrfMerge() — merging', resultLists.length, 'lists, topK:', topK);
  const scores = new Map();
  const meta   = new Map();

  for (const list of resultLists) {
    list.forEach((chunk, rank) => {
      scores.set(chunk.id, (scores.get(chunk.id) || 0) + 1 / (RRF_K + rank + 1));
      if (!meta.has(chunk.id)) meta.set(chunk.id, chunk);
    });
  }

  const merged = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([id, score]) => ({ ...meta.get(id), score: parseFloat(score.toFixed(4)) }));

  log.debug('rrfMerge() merged into', merged.length, 'results');
  return merged;
}

export async function hybridSearchChunks(query, queryVec = null, topK = 5, candidateK = 20) {
  log.info('hybridSearchChunks() START', {
    query:      query.trim().slice(0, 100),
    hasVec:     queryVec !== null,
    topK,
    candidateK,
  });

  if (!query.trim()) {
    log.warn('hybridSearchChunks() empty query — returning []');
    return [];
  }

  const db      = await getDb();
  const startMs = Date.now();

  // ── 1. BM25 via FTS5 ──────────────────────────────────────
  const ftsQuery = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(w => `"${w.replace(/"/g, '""')}"`)
    .join(' ');

  log.debug('hybridSearchChunks() FTS5 query:', ftsQuery);

  let bm25Results = [];
  try {
    const rows = await db.getAllAsync(
      `SELECT c.id, c.source, c.content, c.parent_content, c.parent_id, c.page,
              c.chunk_type, c.section_path, c.heading,
              c.bbox, c.page_width, c.page_height,
              bm25(chunks_fts) AS bm25_score
       FROM chunks_fts
       JOIN chunks c ON c.id = chunks_fts.id
       WHERE chunks_fts MATCH ?
       ORDER BY bm25_score
       LIMIT ?`,
      [ftsQuery, candidateK],
    );
    bm25Results = rows.map(r => ({
      ...r,
      content:   r.parent_content || r.content,
      parent_id: r.parent_id || '',                // NEW
      bbox:      r.bbox ? JSON.parse(r.bbox) : null,
    }));
    log.info('hybridSearchChunks() BM25 (FTS5) →', bm25Results.length, 'results');
  } catch (e) {
    log.warn('hybridSearchChunks() FTS5 search error — trying LIKE fallback:', e.message);
    bm25Results = await _fallbackSearch(query, candidateK);
    log.info('hybridSearchChunks() LIKE fallback →', bm25Results.length, 'results');
  }

  // ── 2. KNN via sqlite-vec ──────────────────────────────────
  let vecResults = [];

  if (queryVec) {
    const vecLen = queryVec.length ?? queryVec.byteLength / 4;
    if (vecLen !== 384) {
      log.warn('hybridSearchChunks() KNN skipped — queryVec wrong length:', vecLen, '(expected 384)');
    } else {
      log.debug('hybridSearchChunks() running KNN search — candidateK:', candidateK);
      try {
        const blob = toVecBlob(queryVec);

        const vecRows = await db.getAllAsync(
          `SELECT v.id, v.distance
           FROM vec_chunks v
           WHERE v.embedding MATCH ?
             AND k = ?
           ORDER BY v.distance`,
          [blob, candidateK],
        );

        log.info('hybridSearchChunks() KNN raw rows:', vecRows.length);

        if (vecRows.length > 0) {
          const ids          = vecRows.map(r => r.id);
          const placeholders = ids.map(() => '?').join(',');
          const chunkRows    = await db.getAllAsync(
            `SELECT id, source, content, parent_content, parent_id, page,
                    chunk_type, section_path, heading,
                    bbox, page_width, page_height
             FROM chunks WHERE id IN (${placeholders})`,
            ids,
          );
          const chunkMap = new Map(chunkRows.map(c => [c.id, c]));
          vecResults = vecRows
            .filter(r => chunkMap.has(r.id))
            .map(r => {
              const chunk = chunkMap.get(r.id);
              return {
                ...chunk,
                content:   chunk.parent_content || chunk.content,
                parent_id: chunk.parent_id || '',      // NEW
                bbox:      chunk.bbox ? JSON.parse(chunk.bbox) : null,
              };
            });
          log.info('hybridSearchChunks() KNN →', vecResults.length, 'results after chunk join');
          // ── SEMANTIC SEARCH ONLY LOG ──────────────────────────
          console.log(`[SEMANTIC/OFFLINE] Query embedding first 10: [${Array.from(queryVec.slice(0, 10)).join(', ')}]`);
          console.log(`[SEMANTIC/OFFLINE] Query embedding norm: ${Math.sqrt(queryVec.reduce((s, v) => s + v * v, 0))}`);
          console.log(`[SEMANTIC/OFFLINE] Full embedding (${queryVec.length} dims): [${Array.from(queryVec).join(', ')}]`);
          console.log(`[SEMANTIC/OFFLINE] KNN returned ${vecResults.length} results:`);
          vecResults.forEach((r, i) => {
            console.log(`[SEMANTIC/OFFLINE] KNN[${i}] src=${r.source} p=${r.page} dist=${r._distance} content="${r.content?.slice(0, 80).replace(/\n/g, ' ')}"`);
          });
          // ───────────────────────────────────────────────────────

        }
      } catch (e) {
        log.warn('hybridSearchChunks() KNN search FAILED:', e.message);
      }
    }
  } else {
    log.debug('hybridSearchChunks() KNN skipped — no queryVec (embedder unavailable)');
  }

  // ── 3. Determine mode and merge ───────────────────────────
  const hasBM25 = bm25Results.length > 0;
  const hasKNN  = vecResults.length  > 0;

  let searchMode;
  if      (hasBM25 && hasKNN)  searchMode = 'hybrid';
  else if (hasBM25 && !hasKNN) searchMode = 'bm25';
  else if (!hasBM25 && hasKNN) searchMode = 'knn';
  else                          searchMode = 'empty';

  log.info(
    `hybridSearchChunks() BM25=${bm25Results.length} KNN=${vecResults.length}`,
    `→ ${searchMode === 'hybrid' ? 'hybrid RRF' : searchMode + '-only'} → top ${topK}`,
    queryVec ? '' : '(no queryVec — embedder unavailable)',
    `| elapsed: ${Date.now() - startMs}ms`,
  );

  if (searchMode === 'empty') {
    log.warn('hybridSearchChunks() no results from either BM25 or KNN — returning []');
    return [];
  }

  const sources = [bm25Results, vecResults].filter(l => l.length > 0);
  let merged;

  if (sources.length === 1) {
    merged = sources[0].slice(0, topK).map((c, i) => ({
      ...c,
      score: parseFloat((1 / (RRF_K + i + 1)).toFixed(4)),
    }));
    log.debug('hybridSearchChunks() single-source result (no RRF needed)');
  } else {
    merged = rrfMerge(sources, topK);
  }

  const result = merged.map(c => ({ ...c, _searchMode: searchMode }));
  log.info('hybridSearchChunks() DONE — returning', result.length, 'results in',
    Date.now() - startMs, 'ms |',
    result.map(c => `${c.source}:p${c.page}(${c.score})`).join(', '));

  return result;
}

// ─────────────────────────────────────────────────────────────
// BM25-ONLY SEARCH (backward compat)
// ─────────────────────────────────────────────────────────────

export async function searchChunks(query, topK = 5) {
  log.info('searchChunks() (BM25-only compat shim) — delegating to hybridSearchChunks()');
  return hybridSearchChunks(query, null, topK, topK * 4);
}

async function _fallbackSearch(query, topK) {
  log.warn('_fallbackSearch() — using LIKE search for:', query.slice(0, 80));
  const db      = await getDb();
  const pattern = `%${query.trim()}%`;
  const rows    = await db.getAllAsync(
    `SELECT id, source, content, parent_content, parent_id, page, chunk_type,
            section_path, heading, bbox, page_width, page_height,
            1.0 AS score
     FROM chunks
     WHERE content LIKE ? OR parent_content LIKE ? OR source LIKE ?
     LIMIT ?`,
    [pattern, pattern, pattern, topK],
  );
  log.info('_fallbackSearch() → returned', rows.length, 'rows');
  return rows.map(r => ({
    ...r,
    content:   r.parent_content || r.content,
    parent_id: r.parent_id || '',           // NEW
    bbox:      r.bbox ? JSON.parse(r.bbox) : null,
    score:     r.score,
  }));
}

// ─────────────────────────────────────────────────────────────
// METADATA HELPERS
// ─────────────────────────────────────────────────────────────

export async function getChunkCount() {
  const db  = await getDb();
  const row = await db.getFirstAsync('SELECT COUNT(*) AS n FROM chunks;');
  const n   = row?.n ?? 0;
  log.debug('getChunkCount() →', n);
  return n;
}

export async function getVectorCount() {
  const db = await getDb();
  try {
    const row = await db.getFirstAsync('SELECT COUNT(*) AS n FROM vec_chunks;');
    const n   = row?.n ?? 0;
    log.debug('getVectorCount() →', n);
    return n;
  } catch (err) {
    log.warn('getVectorCount() failed (vec_chunks unavailable?):', err.message, '→ returning 0');
    return 0;
  }
}

export async function isPdfAvailableLocally(filename) {
  if (!filename) {
    log.debug('isPdfAvailableLocally() — no filename provided → false');
    return false;
  }
  try {
    const path = `${FileSystem.documentDirectory}pdfs/${filename}`;
    const info = await FileSystem.getInfoAsync(path);
    log.debug('isPdfAvailableLocally()', filename, '→', info.exists);
    return info.exists;
  } catch (err) {
    log.warn('isPdfAvailableLocally() error for', filename, ':', err.message, '→ false');
    return false;
  }
}

export async function clearChunks() {
  log.info('clearChunks() START — deleting all chunks, FTS, and vectors');
  const db      = await getDb();
  const startMs = Date.now();

  // FIX: manual transaction + mutex (via withMutex)
  return withMutex(async () => {
    try {
      await db.runAsync('BEGIN;');
      await db.runAsync('DELETE FROM chunks;');
      await db.runAsync('DELETE FROM chunks_fts;');
      log.debug('clearChunks() chunks + FTS cleared');
      try {
        await db.runAsync('DELETE FROM vec_chunks;');
        log.debug('clearChunks() vec_chunks cleared');
      } catch (e) {
        log.warn('clearChunks() vec_chunks clear skipped:', e.message);
      }
      await db.runAsync('COMMIT;');
    } catch (err) {
      log.error('clearChunks() ERROR — rolling back:', err.message);
      try { await db.runAsync('ROLLBACK;'); } catch (_) {
        log.error('clearChunks() ROLLBACK also failed');
      }
      throw err;
    }

    log.info('clearChunks() ✅ DONE in', Date.now() - startMs, 'ms');
  });
}

// ─────────────────────────────────────────────────────────────
// SYNC METADATA
// ─────────────────────────────────────────────────────────────

export async function getSyncMeta(key) {
  const db  = await getDb();
  const row = await db.getFirstAsync(
    'SELECT value FROM sync_meta WHERE key = ?', [key],
  );
  const val = row?.value ?? null;
  log.debug(`getSyncMeta('${key}') →`, val ?? '(null)');
  return val;
}

export async function setSyncMeta(key, value) {
  log.debug(`setSyncMeta('${key}') =`, value);
  const db = await getDb();
  await db.runAsync(
    'INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)',
    [key, String(value)],
  );
}

export async function getAllSyncMeta() {
  const db   = await getDb();
  const rows = await db.getAllAsync('SELECT key, value FROM sync_meta;');
  const meta = Object.fromEntries(rows.map(r => [r.key, r.value]));
  log.debug('getAllSyncMeta() →', meta);
  return meta;
}