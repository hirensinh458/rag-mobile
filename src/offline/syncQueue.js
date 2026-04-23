// src/offline/syncQueue.js
//
// Robust Sync Orchestrator (FIXED VERSION)
// - Restores original retry + status logic
// - Uses new apiFetch(activeUrl)
// - Includes PDF sync
// - Safe for auto + manual sync triggers

import { replaceAllChunks, getChunkCount, getSyncMeta, setSyncMeta } from './db';
import { syncPdfs } from './pdfSync';
import { apiFetch } from '../api/client';

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────
const SYNC_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 30_000;
const SYNC_INTERVAL_MS = 5 * 60 * 1000;

// ─────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────
let _syncing = false;
let _retryCount = 0;
let _retryTimer = null;
let _onStatusChange = null;

/** Register callback for UI updates */
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
 * Full sync from server
 * @param {string} activeUrl
 */
export async function syncFromServer(activeUrl = '') {
  if (_syncing) {
    console.log('[SYNC] Already syncing, skipping');
    return { success: false, error: 'sync_in_progress' };
  }

  _syncing = true;
  _emit({ syncing: true, phase: 'connecting' });

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);

    let response;

    try {
      _emit({ syncing: true, phase: 'fetching' });

      response = await apiFetch('/kb/export', activeUrl, {
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
      });

    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new Error(`Server returned ${response.status}`);
    }

    const data = await response.json();
    const chunks = data.chunks || [];

    // ─────────────────────────────
    // EMPTY DATA CASE
    // ─────────────────────────────
    if (chunks.length === 0) {
      console.log('[SYNC] No chunks on server');

      const now = new Date().toISOString();
      await setSyncMeta('last_synced', now);
      await setSyncMeta('chunk_count', '0');

      _emit({ syncing: false, phase: 'idle', chunkCount: 0 });
      _retryCount = 0;

      return { success: true, chunkCount: 0 };
    }

    // ─────────────────────────────
    // STORE CHUNKS
    // ─────────────────────────────
    _emit({ syncing: true, phase: 'storing', total: chunks.length });

    await replaceAllChunks(chunks);

    const now = new Date().toISOString();
    await setSyncMeta('last_synced', now);
    await setSyncMeta('chunk_count', String(chunks.length));
    await setSyncMeta('server_total', String(data.total || chunks.length));

    console.log(`[SYNC] ✅ Synced ${chunks.length} chunks`);

    // ─────────────────────────────
    // PDF SYNC (NON-BLOCKING SAFE)
    // ─────────────────────────────
    let pdfResult = { synced: [], deleted: [], errors: [] };

    try {
      pdfResult = await syncPdfs(activeUrl);

      if (pdfResult.errors?.length) {
        console.warn('[SYNC] PDF errors:', pdfResult.errors);
      }

    } catch (e) {
      console.warn('[SYNC] PDF sync failed:', e.message);
    }

    _retryCount = 0;

    _emit({
      syncing: false,
      phase: 'done',
      chunkCount: chunks.length,
      lastSynced: now,
    });

    return {
      success: true,
      chunkCount: chunks.length,
      pdfsSynced: pdfResult.synced.length,
      pdfsDeleted: pdfResult.deleted.length,
      errors: pdfResult.errors,
    };

  } catch (err) {
    const isAbort = err.name === 'AbortError';
    const msg = isAbort ? 'Sync timed out' : err.message;

    console.warn(`[SYNC] ❌ Failed (attempt ${_retryCount + 1}): ${msg}`);

    _emit({ syncing: false, phase: 'error', error: msg });

    _scheduleRetry(activeUrl);

    return { success: false, error: msg };

  } finally {
    _syncing = false;
  }
}

// ─────────────────────────────────────────────────────────────
// RETRY LOGIC
// ─────────────────────────────────────────────────────────────

function _scheduleRetry(activeUrl) {
  if (_retryCount >= MAX_RETRIES) {
    console.log('[SYNC] Max retries reached. Waiting for next trigger.');
    _retryCount = 0;
    return;
  }

  const delay = Math.min(BASE_BACKOFF_MS * 2 ** _retryCount, MAX_BACKOFF_MS);
  _retryCount++;

  console.log(`[SYNC] Retrying in ${delay / 1000}s`);

  clearTimeout(_retryTimer);

  _retryTimer = setTimeout(() => {
    syncFromServer(activeUrl);
  }, delay);
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

export async function shouldSync() {
  const localCount = await getChunkCount();
  if (localCount === 0) return true;

  const lastSynced = await getSyncMeta('last_synced');
  if (!lastSynced) return true;

  const elapsed = Date.now() - new Date(lastSynced).getTime();
  return elapsed > SYNC_INTERVAL_MS;
}

export async function getSyncStatus() {
  const lastSynced = await getSyncMeta('last_synced');
  const chunkCount = await getSyncMeta('chunk_count');
  const localCount = await getChunkCount();

  return {
    lastSynced: lastSynced || null,
    chunkCount: parseInt(chunkCount || '0', 10),
    localCount,
    isSyncing: _syncing,
  };
}

export function cancelPendingSync() {
  clearTimeout(_retryTimer);
  _retryCount = 0;
}