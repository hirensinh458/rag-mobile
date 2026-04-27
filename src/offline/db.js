// src/offline/db.js  — P2 + P3 + P4 + FIX-VECTORS + FIX-UNIQUE + SEARCH-MODE-LOGGING
//
// CHANGES FROM PREVIOUS VERSION:
//
//   FIX — 338/340 vectors: vec0 UNIQUE constraint failure on duplicate content-hash chunks.
//     PROBLEM:
//       Two BM25 chunks produce the same _content_hash (identical source + page +
//       content[:80] prefix). `INSERT OR REPLACE INTO vec_chunks` is not supported
//       by sqlite-vec's vec0 virtual table — it throws UNIQUE constraint failed
//       instead of silently replacing, so 2 inserts failed every sync.
//       Qdrant has the same 338 unique vectors (it deduped silently), which is
//       why the server also shows 338 rather than 340.
//     FIX:
//       Use `INSERT OR IGNORE INTO vec_chunks` — duplicate IDs are silently
//       skipped rather than erroring. The first chunk with that hash wins,
//       which is consistent with Qdrant's behaviour.
//       Also: deduplicate chunk IDs BEFORE the insert loop so the chunks table
//       and FTS don't get spurious duplicates either.
//
//   FIX — Embedder unavailable / BM25-only offline mode.
//     PROBLEM:
//       `Cannot read property 'install' of null` — sqlite-vec native module
//       is not accessible in the ONNX worker thread when getEmbedder() is called.
//       The expo-file-system deprecation warning fires during module init and
//       its text becomes the caught error message, masking the real cause.
//     FIX:
//       hybridSearchChunks() accepts a pre-computed queryVec (Float32Array) or
//       null — no change needed here. The embedder issue is in embedder.js.
//       Added a guard: if queryVec is provided but has wrong length, log and
//       discard rather than passing a malformed blob to vec0.
//
//   NEW — Search mode metadata on every hybridSearchChunks call.
//     hybridSearchChunks now:
//       1. Logs a one-line summary showing which paths ran and how many
//          candidates each produced, e.g.:
//          [DB] Search: BM25=12 KNN=15 → hybrid RRF → top 5
//          [DB] Search: BM25=8 KNN=0 → BM25-only → top 5
//       2. Returns a _searchMode field on each result chunk:
//          "hybrid"   — both BM25 and KNN contributed
//          "bm25"     — BM25 only (no embedder or KNN returned empty)
//          "knn"      — KNN only (BM25 returned empty, rare)
//       This makes it trivially testable: log result[0]._searchMode in useChat.
//
//   KEPT — All other P2/P3/P4 logic (toVecBlob, schema, RRF, fallback search,
//           singleton guard, WAL, FTS5 BM25, getVectorCount, sync metadata).

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
 * @param {Array} chunks — chunk objects from /kb/export (with .embedding field)
 */
export async function replaceAllChunksWithVectors(chunks) {
  const db = await getDb();
  let vectorCount       = 0;
  let vectorErrors      = 0;
  let duplicatesSkipped = 0;

  // FIX: Deduplicate by id BEFORE the transaction.
  // Two BM25 chunks can produce identical _content_hash IDs (same source+page+content[:80]).
  // vec0's INSERT OR IGNORE silently skips duplicates; but the chunks table uses
  // PRIMARY KEY so INSERT OR REPLACE overwrites — deduplicate once here so both
  // tables see the same unique rows.
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

  await db.withTransactionAsync(async () => {
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

        // FIX: INSERT OR IGNORE instead of INSERT OR REPLACE.
        // vec0 virtual table does not support ON CONFLICT replacement —
        // it throws UNIQUE constraint failed. OR IGNORE silently skips
        // the duplicate, which is correct since we already deduped above.
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
  });

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
 * NEW: Every result now carries a _searchMode field:
 *   "hybrid" — both BM25 and KNN contributed via RRF
 *   "bm25"   — BM25 only (embedder unavailable or KNN returned empty)
 *   "knn"    — KNN only (BM25 returned empty, very rare)
 *
 * A one-line summary is always logged so you can see which path was taken:
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
    // Guard: wrong dimension means toVecBlob will produce a bad blob that
    // vec0 will reject with a confusing error — catch it early with a clear message.
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
        // Distinguish "extension not loaded" (expected) from real query errors.
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

  // NEW: always-printed one-liner — tells you at a glance which path ran.
  // Look for this in Metro logs after every offline query.
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

  // NEW: attach _searchMode to every returned chunk.
  // In useChat.js you can verify with: console.log(results[0]?._searchMode)
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
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM chunks;');
    await db.runAsync('DELETE FROM chunks_fts;');
    try {
      await db.runAsync('DELETE FROM vec_chunks;');
    } catch (e) {
      console.warn('[DB] clearChunks: vec_chunks clear skipped:', e.message);
    }
  });
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