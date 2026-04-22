// src/offline/syncQueue.js
//
// Sync orchestrator: pulls chunks from the server's /kb/export endpoint
// and stores them in local SQLite for Mode 3 (deep offline) use.
//
// WHEN TO SYNC:
//   - App comes online after being DEEP_OFFLINE
//   - User opens SettingsScreen and taps "Sync now"
//   - Periodic background sync (every SYNC_INTERVAL_MS)
//   - After a new document is ingested on the server
//
// RETRY LOGIC:
//   - Exponential backoff: 2s → 4s → 8s → 16s → 30s (cap)
//   - Max 5 attempts per sync trigger
//   - Gives up gracefully; next poll interval will retry

import { getBaseUrl }     from '../api/client';
import {
  replaceAllChunks,
  getChunkCount,
  getSyncMeta,
  setSyncMeta,
} from './db';

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────
const SYNC_TIMEOUT_MS  = 30_000; // abort if server doesn't respond in 30s
const MAX_RETRIES      = 5;
const BASE_BACKOFF_MS  = 2_000;
const MAX_BACKOFF_MS   = 30_000;
const SYNC_INTERVAL_MS = 5 * 60 * 1000; // re-sync every 5 minutes when online

// ─────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────
let _syncing       = false;
let _retryCount    = 0;
let _retryTimer    = null;
let _onStatusChange = null; // callback: (status) => void

/** Register a callback to be called when sync status changes */
export function onSyncStatusChange(cb) {
  _onStatusChange = cb;
}

function _emit(status) {
  _onStatusChange?.(status);
}

// ─────────────────────────────────────────────────────────────
// MAIN SYNC FUNCTION
// ─────────────────────────────────────────────────────────────

/**
 * Fetch all chunks from the server's /kb/export endpoint and store locally.
 *
 * This replaces the entire local database with fresh server data.
 * For large KBs (>10k chunks), consider paginating — but for ship manuals
 * (typically <5k chunks) a full replace is fine and simpler.
 *
 * Returns: { success: boolean, chunkCount: number, error?: string }
 */
export async function syncFromServer() {
  if (_syncing) {
    console.log('[SYNC] Already syncing, skipping');
    return { success: false, error: 'sync_in_progress' };
  }

  _syncing = true;
  _emit({ syncing: true, phase: 'connecting' });

  try {
    const base       = await getBaseUrl();
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);

    let response;
    try {
      _emit({ syncing: true, phase: 'fetching' });
      response = await fetch(`${base}/kb/export`, {
        signal:  controller.signal,
        headers: { 'Content-Type': 'application/json' },
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new Error(`Server returned ${response.status}`);
    }

    const data   = await response.json();
    const chunks = data.chunks || [];

    if (chunks.length === 0) {
      console.log('[SYNC] Server has no chunks — nothing to sync');
      await setSyncMeta('last_synced', new Date().toISOString());
      await setSyncMeta('chunk_count', '0');
      _emit({ syncing: false, phase: 'idle', chunkCount: 0 });
      _retryCount = 0;
      return { success: true, chunkCount: 0 };
    }

    _emit({ syncing: true, phase: 'storing', total: chunks.length });
    await replaceAllChunks(chunks);

    const now = new Date().toISOString();
    await setSyncMeta('last_synced',  now);
    await setSyncMeta('chunk_count',  String(chunks.length));
    await setSyncMeta('server_total', String(data.total || chunks.length));

    console.log(`[SYNC] ✅ Synced ${chunks.length} chunks at ${now}`);
    _retryCount = 0;
    _emit({ syncing: false, phase: 'done', chunkCount: chunks.length, lastSynced: now });

    return { success: true, chunkCount: chunks.length };

  } catch (err) {
    const isAbort = err.name === 'AbortError';
    const msg     = isAbort ? 'Sync timed out' : err.message;
    console.warn(`[SYNC] ❌ Failed (attempt ${_retryCount + 1}): ${msg}`);

    _emit({ syncing: false, phase: 'error', error: msg });
    _scheduleRetry();

    return { success: false, error: msg };

  } finally {
    _syncing = false;
  }
}

// ─────────────────────────────────────────────────────────────
// RETRY LOGIC
// ─────────────────────────────────────────────────────────────

function _scheduleRetry() {
  if (_retryCount >= MAX_RETRIES) {
    console.log(`[SYNC] Max retries (${MAX_RETRIES}) reached. Giving up until next poll.`);
    _retryCount = 0;
    return;
  }

  const delay = Math.min(BASE_BACKOFF_MS * 2 ** _retryCount, MAX_BACKOFF_MS);
  _retryCount++;

  console.log(`[SYNC] Retrying in ${delay / 1000}s (attempt ${_retryCount}/${MAX_RETRIES})`);

  clearTimeout(_retryTimer);
  _retryTimer = setTimeout(() => {
    syncFromServer();
  }, delay);
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * Returns true if a sync is needed.
 * Sync if: no local chunks, OR last sync was more than SYNC_INTERVAL_MS ago.
 */
export async function shouldSync() {
  const localCount = await getChunkCount();
  if (localCount === 0) return true;

  const lastSynced = await getSyncMeta('last_synced');
  if (!lastSynced) return true;

  const elapsed = Date.now() - new Date(lastSynced).getTime();
  return elapsed > SYNC_INTERVAL_MS;
}

/** Read current sync metadata for display in the UI */
export async function getSyncStatus() {
  const lastSynced  = await getSyncMeta('last_synced');
  const chunkCount  = await getSyncMeta('chunk_count');
  const localCount  = await getChunkCount();

  return {
    lastSynced:  lastSynced  || null,
    chunkCount:  parseInt(chunkCount || '0', 10),
    localCount,
    isSyncing:   _syncing,
  };
}

/** Cancel any pending retry timer */
export function cancelPendingSync() {
  clearTimeout(_retryTimer);
  _retryCount = 0;
}