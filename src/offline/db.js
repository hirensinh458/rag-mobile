// src/offline/db.js  — P2 + P3 + P4 full rewrite
//
// CHANGES FROM PREVIOUS VERSION:
//   P2 — sqlite-vec native extension loaded in getDb() with graceful fallback
//   P2 — vec_chunks virtual table added to schema (384-dim float vectors)
//   P3 — replaceAllChunks() replaced by replaceAllChunksWithVectors()
//         which stores embeddings into vec_chunks alongside text in chunks/FTS5
//   P3 — getVectorCount() added
//   P4 — hybridSearchChunks() added: BM25 (FTS5) + KNN (sqlite-vec) + RRF merge
//   Backward compat: searchChunks() still exported (used as internal fallback)
//
// TABLES:
//   chunks        — structured chunk metadata
//   chunks_fts    — FTS5 virtual table for BM25 keyword search
//   vec_chunks    — sqlite-vec virtual table for KNN semantic search (384-dim)
//   sync_meta     — key/value sync state (last_synced, etag, counts)
//
// REQUIRES:
//   expo-sqlite ~16.x  (loadExtensionAsync support)
//   sqlite-vec v0.1.6 native binaries via plugins/withSqliteVec.js

import * as SQLite     from 'expo-sqlite';
import * as FileSystem from 'expo-file-system/legacy';
import { Platform }    from 'react-native';

// ─────────────────────────────────────────────────────────────
// DB SINGLETON
// ─────────────────────────────────────────────────────────────

let _db = null;

async function getDb() {
  if (_db) return _db;

  _db = await SQLite.openDatabaseAsync('rag_offline.db');

  // WAL mode — faster writes, safe concurrent reads
  await _db.execAsync('PRAGMA journal_mode = WAL;');

  // ── P2: Load sqlite-vec native extension ──────────────────
  // Graceful degradation: if the extension isn't bundled (e.g. first run
  // before prebuild), the app still works with BM25-only search.
  try {
    const libName = Platform.OS === 'android' ? 'vec0' : 'vec0.dylib';
    await _db.loadExtensionAsync(libName);
    console.log('[DB] sqlite-vec extension loaded ✓');
  } catch (e) {
    console.warn('[DB] sqlite-vec not available — BM25-only fallback:', e.message);
  }

  // ── Schema ────────────────────────────────────────────────
  await _db.execAsync(`
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

  // P2: sqlite-vec table — created separately because it needs the extension loaded.
  // Wrapped in try/catch so BM25-only mode still works if extension is absent.
  try {
    await _db.execAsync(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
        id        TEXT PRIMARY KEY,
        embedding FLOAT[384]
      );
    `);
    console.log('[DB] vec_chunks table ready ✓');
  } catch (e) {
    console.warn('[DB] vec_chunks table not created (extension not loaded):', e.message);
  }

  return _db;
}

// ─────────────────────────────────────────────────────────────
// P3: CHUNK OPERATIONS — REPLACE WITH VECTORS
// ─────────────────────────────────────────────────────────────

/**
 * Atomically replace ALL stored chunks, FTS index, AND vector embeddings.
 *
 * Called by syncFromServer() in useOfflineSearch after a successful /kb/export.
 * The entire operation is a single transaction — the app never sees a half-
 * populated database.
 *
 * Vectors are inserted individually with try/catch so one bad embedding
 * doesn't abort the whole sync.
 *
 * @param {Array} chunks — array of chunk objects from /kb/export (with .embedding field)
 */
export async function replaceAllChunksWithVectors(chunks) {
  const db = await getDb();
  let vectorCount = 0;

  await db.withTransactionAsync(async () => {
    // Wipe all three tables atomically
    await db.runAsync('DELETE FROM chunks;');
    await db.runAsync('DELETE FROM chunks_fts;');
    try {
      await db.runAsync('DELETE FROM vec_chunks;');
    } catch {
      /* extension may not be loaded — continue without vectors */
    }

    for (const c of chunks) {
      const id       = c.id || `${c.source}_${c.page || 0}_${Math.random().toString(36).slice(2)}`;
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

      // 2. FTS5 index (BM25 keyword search)
      await db.runAsync(
        'INSERT INTO chunks_fts (id, content, parent_content, source) VALUES (?, ?, ?, ?)',
        [id, c.content || '', c.parent_content || c.content || '', c.source || ''],
      );

      // 3. Vector index (KNN semantic search) — skip silently if extension not loaded
      if (c.embedding && Array.isArray(c.embedding)) {
        try {
          const vecBlob = new Float32Array(c.embedding).buffer;
          await db.runAsync(
            'INSERT OR REPLACE INTO vec_chunks (id, embedding) VALUES (?, ?)',
            [id, vecBlob],
          );
          vectorCount++;
        } catch {
          /* sqlite-vec extension not loaded — silently skip */
        }
      }
    }
  });

  console.log(`[DB] Stored ${chunks.length} chunks, ${vectorCount} vectors`);
}

/**
 * Legacy alias — kept so any existing callers don't break during migration.
 * In new code, call replaceAllChunksWithVectors() directly.
 */
export const replaceAllChunks = replaceAllChunksWithVectors;

// ─────────────────────────────────────────────────────────────
// P4: HYBRID SEARCH — BM25 + KNN + RRF
// ─────────────────────────────────────────────────────────────

const RRF_K = 60; // standard RRF constant — same as the backend hybrid_retriever.py

/**
 * Reciprocal Rank Fusion — merge multiple ranked lists into one.
 *
 * @param {Array[]} resultLists — array of ranked chunk arrays
 * @param {number}  topK        — how many results to return
 */
function rrfMerge(resultLists, topK) {
  const scores = new Map(); // id → accumulated RRF score
  const meta   = new Map(); // id → chunk data (first-seen wins)

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
 * - If queryVec is null (embedder unavailable), falls back to BM25-only.
 * - If sqlite-vec extension is not loaded, KNN step is silently skipped.
 * - If FTS5 fails, falls back to LIKE search.
 *
 * @param {string}           query      — raw user query text
 * @param {Float32Array|null} queryVec  — on-device embedded query (from embedder.embed())
 * @param {number}           topK       — final results to return
 * @param {number}           candidateK — candidates per source before RRF merge
 * @returns {Promise<Array>} — topK chunk objects with .score field
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
    console.warn('[DB] FTS5 search error, trying fallback:', e.message);
    bm25Results = await _fallbackSearch(query, candidateK);
  }

  // ── 2. KNN via sqlite-vec ──────────────────────────────────
  let vecResults = [];
  if (queryVec) {
    try {
      const vecBlob = queryVec.buffer;
      const vecRows = await db.getAllAsync(
        `SELECT v.id, v.distance
         FROM vec_chunks v
         WHERE v.embedding MATCH ?
           AND k = ?
         ORDER BY v.distance`,
        [vecBlob, candidateK],
      );

      if (vecRows.length > 0) {
        // Fetch full chunk data for the matched IDs
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
      // Extension not loaded or sqlite-vec query error — log and continue with BM25 only
      console.warn('[DB] Vector search error (extension not loaded?):', e.message);
    }
  }

  // ── 3. RRF merge ──────────────────────────────────────────
  const sources = [bm25Results, vecResults].filter(l => l.length > 0);

  if (sources.length === 0) return [];

  if (sources.length === 1) {
    // Only one source — normalize scores without RRF
    return sources[0].slice(0, topK).map((c, i) => ({
      ...c,
      score: parseFloat((1 / (RRF_K + i + 1)).toFixed(4)),
    }));
  }

  console.log(`[DB] Hybrid merge: ${bm25Results.length} BM25 + ${vecResults.length} KNN → top ${topK}`);
  return rrfMerge(sources, topK);
}

// ─────────────────────────────────────────────────────────────
// BM25-ONLY SEARCH (kept for backward compatibility + fallback)
// ─────────────────────────────────────────────────────────────

/**
 * BM25 keyword search (FTS5 only, no vector component).
 * Used by useChat.js Mode 3 path when no embedder is available,
 * and as internal fallback inside hybridSearchChunks().
 */
export async function searchChunks(query, topK = 5) {
  return hybridSearchChunks(query, null, topK, topK * 4);
}

/** LIKE-based fallback if FTS5 query is malformed */
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

/** Total number of locally stored chunks */
export async function getChunkCount() {
  const db  = await getDb();
  const row = await db.getFirstAsync('SELECT COUNT(*) AS n FROM chunks;');
  return row?.n ?? 0;
}

/** Total number of vectors in sqlite-vec (0 if extension not loaded) */
export async function getVectorCount() {
  const db = await getDb();
  try {
    const row = await db.getFirstAsync('SELECT COUNT(*) AS n FROM vec_chunks;');
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

/** Check whether a PDF file has been downloaded locally during sync */
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

/** Wipe all chunks, FTS index, and vectors */
export async function clearChunks() {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM chunks;');
    await db.runAsync('DELETE FROM chunks_fts;');
    try { await db.runAsync('DELETE FROM vec_chunks;'); } catch { /* no extension */ }
  });
  console.log('[DB] Local chunks cleared');
}

// ─────────────────────────────────────────────────────────────
// SYNC METADATA
// ─────────────────────────────────────────────────────────────

export async function getSyncMeta(key) {
  const db  = await getDb();
  const row = await db.getFirstAsync(
    'SELECT value FROM sync_meta WHERE key = ?', [key]
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