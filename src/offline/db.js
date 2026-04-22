// src/offline/db.js
//
// Local SQLite database for offline chunk storage and sync metadata.
// Uses expo-sqlite v2 (async API, SDK 50+).
//
// TABLES:
//   chunks     — full-text searchable via FTS5 virtual table
//   sync_meta  — key/value store for sync state (last_synced, etag, etc.)
//
// FTS5 gives us SQLite's built-in full-text search (BM25 ranking built in).
// No need to implement BM25 manually — SQLite does it for free.
//
// REQUIRES: expo-sqlite (~15.1.2)
//   npx expo install expo-sqlite

import * as SQLite from 'expo-sqlite';

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
      id            TEXT    PRIMARY KEY,
      source        TEXT    NOT NULL DEFAULT '',
      content       TEXT    NOT NULL DEFAULT '',
      parent_content TEXT   NOT NULL DEFAULT '',
      page          INTEGER NOT NULL DEFAULT 0,
      chunk_type    TEXT    NOT NULL DEFAULT 'text',
      score         REAL    NOT NULL DEFAULT 0,
      synced_at     INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );

    -- FTS5 virtual table mirrors 'chunks' for full-text search
    -- content='' means FTS5 stores its own copy (no external content table race)
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      id         UNINDEXED,
      content,
      source     UNINDEXED,
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
 * Called by syncQueue.syncFromServer() after a successful /kb/export fetch.
 *
 * Uses a transaction so the wipe + insert is atomic — the app never
 * sees a half-populated database.
 */
export async function replaceAllChunks(chunks) {
  const db = await getDb();

  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM chunks;');
    await db.runAsync('DELETE FROM chunks_fts;');

    for (const c of chunks) {
      const id = c.id || `${c.source}_${c.page || 0}_${Math.random().toString(36).slice(2)}`;
      await db.runAsync(
        `INSERT OR REPLACE INTO chunks
           (id, source, content, parent_content, page, chunk_type)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          id,
          c.source        || '',
          c.content       || '',
          c.parent_content || c.content || '',
          c.page          || 0,
          c.chunk_type    || 'text',
        ],
      );

      // Mirror into FTS5 for full-text search
      await db.runAsync(
        'INSERT INTO chunks_fts (id, content, source) VALUES (?, ?, ?)',
        [id, c.content || '', c.source || ''],
      );
    }
  });

  console.log(`[DB] Stored ${chunks.length} chunks locally`);
}

/**
 * Full-text search using SQLite's built-in FTS5 BM25 ranking.
 * Returns up to `topK` chunks sorted by relevance (best first).
 *
 * The porter stemmer means "engine" matches "engines", "engineered", etc.
 */
export async function searchChunks(query, topK = 5) {
  if (!query.trim()) return [];

  const db = await getDb();

  // FTS5 match syntax: wrap each word to avoid operator errors
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
         bm25(chunks_fts) AS bm25_score
       FROM chunks_fts
       JOIN chunks c ON c.id = chunks_fts.id
       WHERE chunks_fts MATCH ?
       ORDER BY bm25_score        -- lower = better in SQLite FTS5
       LIMIT ?`,
      [ftsQuery, topK],
    );

    // Normalise scores to [0, 1] range, higher = better
    // SQLite's bm25() returns negative values (more negative = better match)
    if (rows.length === 0) return [];

    const rawScores = rows.map(r => r.bm25_score);
    const minScore  = Math.min(...rawScores); // most negative = best
    const maxScore  = Math.max(...rawScores);
    const range     = maxScore - minScore || 1;

    return rows.map(r => ({
      id:             r.id,
      source:         r.source,
      content:        r.parent_content || r.content, // show readable parent passage
      page:           r.page,
      chunk_type:     r.chunk_type,
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
    `SELECT id, source, content, parent_content, page, chunk_type, 1.0 AS score
     FROM chunks
     WHERE content LIKE ? OR source LIKE ?
     LIMIT ?`,
    [pattern, pattern, topK],
  );
  return rows.map(r => ({
    ...r,
    content: r.parent_content || r.content,
    score:   r.score,
  }));
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
  const db  = await getDb();
  const rows = await db.getAllAsync('SELECT key, value FROM sync_meta;');
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}