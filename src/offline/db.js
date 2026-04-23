// src/offline/db.js
//
// Local SQLite database for offline chunk storage and sync metadata.
// Uses expo-sqlite v2 (async API, SDK 50+).
//
// CHANGES:
//   - FTS5 table now indexes `parent_content` in addition to `content`
//     so broader context is searchable offline (fixes "only 3 chunks" bug)
//   - `replaceAllChunks` stores bbox, page_width, page_height, section_path
//     from the enriched /kb/export response
//   - `searchChunks` passes parent_content to FTS5 match, returns bbox/section_path
//   - Added `isPdfAvailableLocally(filename)` helper for OfflineChunkCard
//
// TABLES:
//   chunks     — full-text searchable via FTS5 virtual table
//   sync_meta  — key/value store for sync state (last_synced, etag, etc.)
//
// NOTE: The FTS5 schema changed (added parent_content column).
//       On first launch after this update the table is dropped and recreated
//       automatically. A fresh sync is required to repopulate.
//
// REQUIRES: expo-sqlite (~16.x)

import * as SQLite     from 'expo-sqlite';
import * as FileSystem from 'expo-file-system/legacy';

// ─────────────────────────────────────────────────────────────
// DB SINGLETON
// ─────────────────────────────────────────────────────────────
let _db = null;

async function getDb() {
  if (_db) return _db;

  _db = await SQLite.openDatabaseAsync('rag_offline.db');

  // WAL mode — faster writes, safe concurrent reads
  await _db.execAsync('PRAGMA journal_mode = WAL;');

  await _db.execAsync(`
    CREATE TABLE IF NOT EXISTS chunks (
      id             TEXT    PRIMARY KEY,
      source         TEXT    NOT NULL DEFAULT '',
      content        TEXT    NOT NULL DEFAULT '',
      parent_content TEXT    NOT NULL DEFAULT '',
      page           INTEGER NOT NULL DEFAULT 0,
      chunk_type     TEXT    NOT NULL DEFAULT 'text',
      score          REAL    NOT NULL DEFAULT 0,
      section_path   TEXT    NOT NULL DEFAULT '',
      heading        TEXT    NOT NULL DEFAULT '',
      bbox           TEXT    DEFAULT NULL,
      page_width     REAL    DEFAULT NULL,
      page_height    REAL    DEFAULT NULL,
      synced_at      INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );

    -- FTS5 virtual table — indexes BOTH content and parent_content
    -- so broader context is searchable in deep_offline mode.
    -- content='' means FTS5 stores its own copy (no external content race).
    -- IMPORTANT: If you change this schema, drop and recreate the table,
    -- then trigger a fresh sync.
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      id             UNINDEXED,
      content,
      parent_content,
      source         UNINDEXED,
      tokenize = 'porter unicode61'
    );

    -- Sync metadata (last_synced ISO string, doc count, server etag, etc.)
    CREATE TABLE IF NOT EXISTS sync_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  return _db;
}

// ─────────────────────────────────────────────────────────────
// CHUNK OPERATIONS
// ─────────────────────────────────────────────────────────────

/**
 * Replace ALL stored chunks with a fresh batch from the server.
 * Called by syncQueue / useOfflineSearch after a successful /kb/export fetch.
 *
 * Uses a transaction so the wipe + insert is atomic — the app never
 * sees a half-populated database.
 *
 * Stores the new enriched fields: bbox, page_width, page_height, section_path.
 */
export async function replaceAllChunks(chunks) {
  const db = await getDb();

  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM chunks;');
    await db.runAsync('DELETE FROM chunks_fts;');

    for (const c of chunks) {
      const id = c.id || `${c.source}_${c.page || 0}_${Math.random().toString(36).slice(2)}`;

      // Serialize bbox array as JSON string (SQLite has no array type)
      const bboxJson = Array.isArray(c.bbox) ? JSON.stringify(c.bbox) : null;

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

      // Mirror into FTS5 for full-text search — index both content and parent_content
      await db.runAsync(
        'INSERT INTO chunks_fts (id, content, parent_content, source) VALUES (?, ?, ?, ?)',
        [id, c.content || '', c.parent_content || c.content || '', c.source || ''],
      );
    }
  });

  console.log(`[DB] Stored ${chunks.length} chunks locally`);
}

/**
 * Full-text search using SQLite's built-in FTS5 BM25 ranking.
 * Returns up to `topK` chunks sorted by relevance (best first).
 *
 * Matches against BOTH content (child chunk) and parent_content (broader context)
 * so vocabulary-sparse child chunks still surface relevant parent passages.
 *
 * The porter stemmer means "engine" matches "engines", "engineered", etc.
 */
export async function searchChunks(query, topK = 5) {
  if (!query.trim()) return [];

  const db = await getDb();

  // FTS5 match syntax: quote each word to avoid operator errors
  const ftsQuery = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(w => `"${w.replace(/"/g, '""')}"`)
    .join(' ');

  try {
    const rows = await db.getAllAsync(
      `SELECT
         c.id,
         c.source,
         c.content,
         c.parent_content,
         c.page,
         c.chunk_type,
         c.section_path,
         c.heading,
         c.bbox,
         c.page_width,
         c.page_height,
         bm25(chunks_fts) AS bm25_score
       FROM chunks_fts
       JOIN chunks c ON c.id = chunks_fts.id
       WHERE chunks_fts MATCH ?
       ORDER BY bm25_score        -- lower = better in SQLite FTS5
       LIMIT ?`,
      [ftsQuery, topK],
    );

    if (rows.length === 0) return [];

    // Normalise scores to [0, 1] range, higher = better
    // SQLite's bm25() returns negative values (more negative = better match)
    const rawScores = rows.map(r => r.bm25_score);
    const minScore  = Math.min(...rawScores);
    const maxScore  = Math.max(...rawScores);
    const range     = maxScore - minScore || 1;

    return rows.map(r => ({
      id:             r.id,
      source:         r.source,
      content:        r.parent_content || r.content,  // prefer broader context for display
      page:           r.page,
      chunk_type:     r.chunk_type,
      section_path:   r.section_path || '',
      heading:        r.heading      || '',
      // Parse bbox back from JSON string
      bbox:           r.bbox ? JSON.parse(r.bbox) : null,
      page_width:     r.page_width  ?? null,
      page_height:    r.page_height ?? null,
      score:          parseFloat(((maxScore - r.bm25_score) / range).toFixed(4)),
    }));
  } catch (e) {
    // FTS5 match throws if query is malformed (e.g. standalone quotes)
    // Fall back to a plain LIKE search
    console.warn('[DB] FTS5 search failed, falling back to LIKE:', e.message);
    return fallbackSearch(query, topK);
  }
}

/** LIKE-based fallback if FTS5 query is malformed */
async function fallbackSearch(query, topK) {
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
    content:  r.parent_content || r.content,
    bbox:     r.bbox ? JSON.parse(r.bbox) : null,
    score:    r.score,
  }));
}

/**
 * Check whether a PDF file has been downloaded locally during sync.
 * Used by OfflineChunkCard to conditionally show the "Open in manual" button.
 *
 * @param {string} filename — e.g. "engine_manual.pdf"
 * @returns {Promise<boolean>}
 */
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

/** Total number of locally stored chunks */
export async function getChunkCount() {
  const db  = await getDb();
  const row = await db.getFirstAsync('SELECT COUNT(*) AS n FROM chunks;');
  return row?.n ?? 0;
}

/** Wipe all chunks and FTS index */
export async function clearChunks() {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM chunks;');
    await db.runAsync('DELETE FROM chunks_fts;');
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