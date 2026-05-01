// src/offline/db.js  — P2 + P3 + P4 + FIX-VECTORS + FIX-UNIQUE + SEARCH-MODE-LOGGING + FIX-TRANSACTION
//
// CHANGES FROM PREVIOUS VERSION:
//
//   FIX — "cannot start a transaction within a transaction"
//     PROBLEM:
//       expo-sqlite's withTransactionAsync() calls execAsync('BEGIN') internally.
//       execAsync() cannot be called while any transaction is already open on the
//       same database connection. When two sync triggers fire close together at
//       startup (Effect 1 + Effect 2 in useOfflineSearch both fire), the second
//       call to replaceAllChunksWithVectors() arrives while the first transaction
//       is still open, and the nested execAsync('BEGIN') throws.
//     FIX:
//       Replace every withTransactionAsync() call with manual
//       BEGIN / COMMIT / ROLLBACK using runAsync(), which does not call
//       execAsync() and is safe to use without the nested-transaction restriction.
//       A try/catch wraps the entire block so ROLLBACK always fires on error,
//       leaving the DB in a clean state for the next operation.
//
//   KEPT — All other P2/P3/P4/FIX-VECTORS/FIX-UNIQUE/SEARCH-MODE-LOGGING logic.

import * as SQLite     from 'expo-sqlite';
import * as FileSystem from 'expo-file-system/legacy';
import { Platform }    from 'react-native';

// ─────────────────────────────────────────────────────────────
// BLOB HELPER
// ─────────────────────────────────────────────────────────────
//
// expo-sqlite runAsync() cannot bind ArrayBuffer — only Uint8Array.
// Float32Array.buffer gives ArrayBuffer → TypeError on bind.
// toVecBlob() normalises all input types to Uint8Array.

function toVecBlob(embedding) {
  if (embedding instanceof Uint8Array)   return embedding;
  if (embedding instanceof Float32Array) return new Uint8Array(embedding.buffer);
  // Plain number[] from JSON (most common — server payload)
  return new Uint8Array(new Float32Array(embedding).buffer);
}

// ─────────────────────────────────────────────────────────────
// DB SINGLETON — promise-guarded to prevent concurrent init
// ─────────────────────────────────────────────────────────────

let _db     = null;
let _dbInit = null;

async function getDb() {
  if (_db) return _db;
  if (!_dbInit) {
    _dbInit = _initDb().catch(err => {
      _dbInit = null;
      _db     = null;
      throw err;
    });
  }
  return _dbInit;
}

async function _initDb() {
  const db = await SQLite.openDatabaseAsync('rag_offline.db');

  await db.execAsync('PRAGMA journal_mode = WAL;');

  // ── Load sqlite-vec native extension ──────────────────────
  try {
    const libName = Platform.OS === 'android' ? 'vec0' : 'vec0.dylib';
    await db.loadExtensionAsync(libName);
    console.log('[DB] sqlite-vec extension loaded ✓');
  } catch (e) {
    console.warn('[DB] sqlite-vec not available — BM25-only fallback:', e.message);
  }

  // ── Schema ────────────────────────────────────────────────
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS chunks (
      id             TEXT    PRIMARY KEY,
      source         TEXT    NOT NULL DEFAULT '',
      content        TEXT    NOT NULL DEFAULT '',
      parent_content TEXT    NOT NULL DEFAULT '',
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

  // vec_chunks — requires extension already loaded
  try {
    await db.execAsync(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
        id        TEXT PRIMARY KEY,
        embedding FLOAT[384]
      );
    `);
    console.log('[DB] vec_chunks table ready ✓');
  } catch (e) {
    console.warn('[DB] vec_chunks table not created:', e.message);
  }

  _db = db;
  return _db;
}

// ─────────────────────────────────────────────────────────────
// P3: CHUNK OPERATIONS — REPLACE WITH VECTORS
// ─────────────────────────────────────────────────────────────

/**
 * Atomically replace ALL stored chunks, FTS index, AND vector embeddings.
 *
 * FIX: Uses manual BEGIN/COMMIT/ROLLBACK via runAsync() instead of
 * withTransactionAsync(). withTransactionAsync() calls execAsync('BEGIN')
 * internally, which throws "cannot start a transaction within a transaction"
 * when two sync triggers overlap at startup. runAsync('BEGIN') does not
 * have this restriction.
 *
 * @param {Array} chunks — chunk objects from /kb/export (with .embedding field)
 */
export async function replaceAllChunksWithVectors(chunks) {
  const db = await getDb();
  let vectorCount       = 0;
  let vectorErrors      = 0;
  let duplicatesSkipped = 0;

  // Deduplicate by id BEFORE the transaction.
  const seen   = new Set();
  const unique = [];
  for (const c of chunks) {
    const id = c.id || `${c.source}_${c.page ?? 0}_${Math.random().toString(36).slice(2)}`;
    if (seen.has(id)) {
      duplicatesSkipped++;
      console.warn(`[DB] Duplicate chunk id skipped: ${id} (source=${c.source} page=${c.page})`);
      continue;
    }
    seen.add(id);
    unique.push({ ...c, _resolvedId: id });
  }

  if (duplicatesSkipped > 0) {
    console.warn(`[DB] Deduplication: ${duplicatesSkipped} duplicate chunk(s) dropped before insert`);
  }

  // FIX: manual transaction — runAsync('BEGIN') is safe even when another
  // async operation is in flight; withTransactionAsync/execAsync('BEGIN') is not.
  try {
    await db.runAsync('BEGIN;');

    await db.runAsync('DELETE FROM chunks;');
    await db.runAsync('DELETE FROM chunks_fts;');
    try {
      await db.runAsync('DELETE FROM vec_chunks;');
    } catch (e) {
      console.warn('[DB] vec_chunks DELETE skipped (extension not loaded?):', e.message);
    }

    for (const c of unique) {
      const id       = c._resolvedId;
      const bboxJson = Array.isArray(c.bbox) ? JSON.stringify(c.bbox) : null;

      // 1. Main chunks table
      await db.runAsync(
        `INSERT OR REPLACE INTO chunks
           (id, source, content, parent_content, page, chunk_type,
            section_path, heading, bbox, page_width, page_height)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          c.source         || '',
          c.content        || '',
          c.parent_content || c.content || '',
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
        console.warn(`[DB] Wrong embedding dimension for ${id}: ${c.embedding.length} (expected 384)`);
        vectorErrors++;
        continue;
      }

      try {
        const blob = toVecBlob(c.embedding);

        // INSERT OR IGNORE — vec0 virtual table does not support ON CONFLICT
        // replacement; OR IGNORE silently skips duplicates (already deduped above).
        await db.runAsync(
          'INSERT OR IGNORE INTO vec_chunks (id, embedding) VALUES (?, ?)',
          [id, blob],
        );
        vectorCount++;
      } catch (e) {
        console.error(`[DB] vec insert failed for chunk ${id}: ${e.message}`);
        vectorErrors++;
      }
    }

    await db.runAsync('COMMIT;');

  } catch (err) {
    // Always roll back on any error so the DB is never left in a
    // partial-transaction state that would block all future operations.
    try { await db.runAsync('ROLLBACK;'); } catch (_) { /* ignore rollback errors */ }
    throw err;
  }

  if (vectorErrors > 0) {
    console.warn(
      `[DB] Stored ${unique.length} chunks, ${vectorCount} vectors ` +
      `(${vectorErrors} vec errors, ${duplicatesSkipped} duplicates dropped)`
    );
  } else {
    console.log(
      `[DB] Stored ${unique.length} chunks, ${vectorCount} vectors` +
      (duplicatesSkipped > 0 ? ` (${duplicatesSkipped} duplicates dropped)` : '')
    );
  }
}

export const replaceAllChunks = replaceAllChunksWithVectors;

// ─────────────────────────────────────────────────────────────
// P4: HYBRID SEARCH — BM25 + KNN + RRF
// ─────────────────────────────────────────────────────────────

const RRF_K = 60;

function rrfMerge(resultLists, topK) {
  const scores = new Map();
  const meta   = new Map();

  for (const list of resultLists) {
    list.forEach((chunk, rank) => {
      scores.set(chunk.id, (scores.get(chunk.id) || 0) + 1 / (RRF_K + rank + 1));
      if (!meta.has(chunk.id)) meta.set(chunk.id, chunk);
    });
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([id, score]) => ({ ...meta.get(id), score: parseFloat(score.toFixed(4)) }));
}

/**
 * Hybrid search: BM25 (FTS5) + Semantic KNN (sqlite-vec) → RRF merge.
 *
 * Every result carries a _searchMode field:
 *   "hybrid" — both BM25 and KNN contributed via RRF
 *   "bm25"   — BM25 only (embedder unavailable or KNN returned empty)
 *   "knn"    — KNN only (BM25 returned empty, very rare)
 *
 * A one-line summary is always logged:
 *   [DB] Search: BM25=12 KNN=15 → hybrid RRF → top 5
 *   [DB] Search: BM25=8 KNN=0 → bm25-only → top 5
 *
 * @param {string}                    query      — raw user query text
 * @param {Float32Array|number[]|null} queryVec  — on-device embedded query (null = BM25 only)
 * @param {number}                    topK       — final results to return
 * @param {number}                    candidateK — candidates per source before merge
 */
export async function hybridSearchChunks(query, queryVec = null, topK = 5, candidateK = 20) {
  if (!query.trim()) return [];

  const db = await getDb();

  // ── 1. BM25 via FTS5 ──────────────────────────────────────
  const ftsQuery = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(w => `"${w.replace(/"/g, '""')}"`)
    .join(' ');

  let bm25Results = [];
  try {
    const rows = await db.getAllAsync(
      `SELECT c.id, c.source, c.content, c.parent_content, c.page,
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
      content: r.parent_content || r.content,
      bbox:    r.bbox ? JSON.parse(r.bbox) : null,
    }));
  } catch (e) {
    console.warn('[DB] FTS5 search error, trying LIKE fallback:', e.message);
    bm25Results = await _fallbackSearch(query, candidateK);
  }

  // ── 2. KNN via sqlite-vec ──────────────────────────────────
  let vecResults = [];

  if (queryVec) {
    const vecLen = queryVec.length ?? queryVec.byteLength / 4;
    if (vecLen !== 384) {
      console.warn(`[DB] KNN skipped — queryVec has wrong length: ${vecLen} (expected 384)`);
    } else {
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

        if (vecRows.length > 0) {
          const ids          = vecRows.map(r => r.id);
          const placeholders = ids.map(() => '?').join(',');
          const chunkRows    = await db.getAllAsync(
            `SELECT id, source, content, parent_content, page,
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
                content: chunk.parent_content || chunk.content,
                bbox:    chunk.bbox ? JSON.parse(chunk.bbox) : null,
              };
            });
        }
      } catch (e) {
        console.warn('[DB] KNN search failed:', e.message);
      }
    }
  }

  // ── 3. Determine mode, log summary, RRF merge ─────────────
  const hasBM25 = bm25Results.length > 0;
  const hasKNN  = vecResults.length  > 0;

  let searchMode;
  if      (hasBM25 && hasKNN)  searchMode = 'hybrid';
  else if (hasBM25 && !hasKNN) searchMode = 'bm25';
  else if (!hasBM25 && hasKNN) searchMode = 'knn';
  else                          searchMode = 'empty';

  console.log(
    `[DB] Search: BM25=${bm25Results.length} KNN=${vecResults.length} ` +
    `→ ${searchMode === 'hybrid' ? 'hybrid RRF' : searchMode + '-only'} → top ${topK}` +
    (queryVec ? '' : ' (no queryVec — embedder unavailable)')
  );

  if (searchMode === 'empty') return [];

  const sources = [bm25Results, vecResults].filter(l => l.length > 0);
  let merged;

  if (sources.length === 1) {
    merged = sources[0].slice(0, topK).map((c, i) => ({
      ...c,
      score: parseFloat((1 / (RRF_K + i + 1)).toFixed(4)),
    }));
  } else {
    merged = rrfMerge(sources, topK);
  }

  return merged.map(c => ({ ...c, _searchMode: searchMode }));
}

// ─────────────────────────────────────────────────────────────
// BM25-ONLY SEARCH (backward compat + internal fallback)
// ─────────────────────────────────────────────────────────────

export async function searchChunks(query, topK = 5) {
  return hybridSearchChunks(query, null, topK, topK * 4);
}

async function _fallbackSearch(query, topK) {
  const db      = await getDb();
  const pattern = `%${query.trim()}%`;
  const rows    = await db.getAllAsync(
    `SELECT id, source, content, parent_content, page, chunk_type,
            section_path, heading, bbox, page_width, page_height,
            1.0 AS score
     FROM chunks
     WHERE content LIKE ? OR parent_content LIKE ? OR source LIKE ?
     LIMIT ?`,
    [pattern, pattern, pattern, topK],
  );
  return rows.map(r => ({
    ...r,
    content: r.parent_content || r.content,
    bbox:    r.bbox ? JSON.parse(r.bbox) : null,
    score:   r.score,
  }));
}

// ─────────────────────────────────────────────────────────────
// METADATA HELPERS
// ─────────────────────────────────────────────────────────────

export async function getChunkCount() {
  const db  = await getDb();
  const row = await db.getFirstAsync('SELECT COUNT(*) AS n FROM chunks;');
  return row?.n ?? 0;
}

export async function getVectorCount() {
  const db = await getDb();
  try {
    const row = await db.getFirstAsync('SELECT COUNT(*) AS n FROM vec_chunks;');
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

export async function isPdfAvailableLocally(filename) {
  if (!filename) return false;
  try {
    const path = `${FileSystem.documentDirectory}pdfs/${filename}`;
    const info = await FileSystem.getInfoAsync(path);
    return info.exists;
  } catch {
    return false;
  }
}

export async function clearChunks() {
  const db = await getDb();
  // FIX: manual transaction — same reason as replaceAllChunksWithVectors above
  try {
    await db.runAsync('BEGIN;');
    await db.runAsync('DELETE FROM chunks;');
    await db.runAsync('DELETE FROM chunks_fts;');
    try {
      await db.runAsync('DELETE FROM vec_chunks;');
    } catch (e) {
      console.warn('[DB] clearChunks: vec_chunks clear skipped:', e.message);
    }
    await db.runAsync('COMMIT;');
  } catch (err) {
    try { await db.runAsync('ROLLBACK;'); } catch (_) { /* ignore */ }
    throw err;
  }
  console.log('[DB] Local chunks cleared');
}

// ─────────────────────────────────────────────────────────────
// SYNC METADATA
// ─────────────────────────────────────────────────────────────

export async function getSyncMeta(key) {
  const db  = await getDb();
  const row = await db.getFirstAsync(
    'SELECT value FROM sync_meta WHERE key = ?', [key],
  );
  return row?.value ?? null;
}

export async function setSyncMeta(key, value) {
  const db = await getDb();
  await db.runAsync(
    'INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)',
    [key, String(value)],
  );
}

export async function getAllSyncMeta() {
  const db   = await getDb();
  const rows = await db.getAllAsync('SELECT key, value FROM sync_meta;');
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}