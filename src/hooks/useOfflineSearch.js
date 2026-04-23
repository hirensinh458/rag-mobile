// src/hooks/useOfflineSearch.js
//
// Auto-sync hook — triggers a background sync whenever the app transitions
// from deep_offline to a reachable server, or when activeUrl becomes
// available for the first time.
//
// FIXES:
//   - NetworkMode is now imported from useNetwork (it is exported there)
//   - Hook is wired into ChatScreen so it is actually instantiated
//   - Sync triggers on ANY reachable mode (not just deep_offline → online)
//   - activeUrl is threaded through to syncFromServer so the right URL is used

import { useState, useEffect, useRef, useCallback } from 'react';
import { NetworkMode } from './useNetwork';
import { replaceAllChunks, setSyncMeta, getChunkCount, getSyncMeta } from '../offline/db';
import { syncPdfs }    from '../offline/pdfSync';
import { apiFetch }    from '../api/client';

const SYNC_STALE_MS = 30 * 60 * 1000; // consider sync stale after 30 minutes

/**
 * Check whether a sync is needed based on last_synced timestamp.
 * Returns true if never synced, or if last sync was > SYNC_STALE_MS ago.
 */
async function shouldSync() {
  try {
    const lastSynced = await getSyncMeta('last_synced');
    if (!lastSynced) return true;
    const elapsed = Date.now() - new Date(lastSynced).getTime();
    return elapsed > SYNC_STALE_MS;
  } catch {
    return true;
  }
}

/**
 * Perform a full sync: fetch chunks from /kb/export and PDFs from /documents.
 *
 * @param {string} activeUrl — base URL to fetch from (from useNetwork.activeUrl)
 */
async function syncFromServer(activeUrl) {
  // 1. Fetch all chunks from /kb/export
  const res    = await apiFetch('/kb/export', activeUrl);
  const data   = await res.json();
  const chunks = data.chunks || [];

  // 2. Atomically replace local SQLite (chunks + FTS index)
  await replaceAllChunks(chunks);

  // 3. Sync PDFs — downloads new ones, removes stale ones
  const pdfResult = await syncPdfs(activeUrl);

  // 4. Persist sync metadata
  const now = new Date().toISOString();
  await setSyncMeta('last_synced',  now);
  await setSyncMeta('chunk_count',  String(chunks.length));

  return {
    chunks:      chunks.length,
    pdfsSynced:  pdfResult.synced.length,
    pdfsDeleted: pdfResult.deleted.length,
    errors:      pdfResult.errors,
  };
}

/**
 * useOfflineSearch(mode, activeUrl)
 *
 * Automatically syncs local SQLite when:
 *   1. The app comes back from deep_offline (server becomes reachable), OR
 *   2. activeUrl changes from empty to a real URL (first server contact)
 *
 * Returns:
 *   syncStatus  — { isSyncing, lastSynced, chunkCount, lastResult }
 *   triggerSync — call to force an immediate sync (used by SettingsScreen manual button)
 */
export function useOfflineSearch(mode, activeUrl = '') {
  const [syncStatus, setSyncStatus] = useState({
    isSyncing:  false,
    lastSynced: null,
    chunkCount: 0,
    lastResult: null,
  });

  const prevMode      = useRef(null);
  const prevActiveUrl = useRef('');
  const isSyncingRef  = useRef(false); // prevent concurrent syncs

  // Load persisted sync state on mount
  useEffect(() => {
    (async () => {
      try {
        const [lastSynced, count] = await Promise.all([
          getSyncMeta('last_synced'),
          getChunkCount(),
        ]);
        setSyncStatus(s => ({ ...s, lastSynced, chunkCount: count }));
      } catch { /* non-fatal */ }
    })();
  }, []);

  const triggerSync = useCallback(async (urlOverride) => {
    if (isSyncingRef.current) return;
    const url = urlOverride || activeUrl;
    if (!url) return; // nothing to sync against

    isSyncingRef.current = true;
    setSyncStatus(s => ({ ...s, isSyncing: true }));

    try {
      const result = await syncFromServer(url);
      const count  = await getChunkCount();
      setSyncStatus(s => ({
        ...s,
        isSyncing:  false,
        lastSynced: new Date().toISOString(),
        chunkCount: count,
        lastResult: result,
      }));
      console.log(`[useOfflineSearch] Sync complete — ${result.chunks} chunks, ${result.pdfsSynced} PDFs`);
    } catch (err) {
      console.warn('[useOfflineSearch] Sync failed:', err.message);
      setSyncStatus(s => ({
        ...s,
        isSyncing:  false,
        lastResult: { error: err.message },
      }));
    } finally {
      isSyncingRef.current = false;
    }
  }, [activeUrl]);

  // Effect 1: Trigger sync on mode transition from deep_offline → reachable
  useEffect(() => {
    const prev         = prevMode.current;
    const isNowReachable = (
      mode === NetworkMode.FULL_ONLINE ||
      mode === NetworkMode.INTRANET_ONLY
    );
    const wasOffline = (
      prev === NetworkMode.DEEP_OFFLINE ||
      prev === null  // initial mount — treat as "coming from offline"
    );

    if (isNowReachable && wasOffline && activeUrl) {
      shouldSync().then(needed => {
        if (needed) {
          console.log('[useOfflineSearch] Mode became reachable — triggering sync');
          triggerSync(activeUrl);
        }
      });
    }

    prevMode.current = mode;
  }, [mode, activeUrl, triggerSync]);

  // Effect 2: Trigger sync when activeUrl changes from empty → non-empty
  // (catches the case where the app starts online and a new local server comes up)
  useEffect(() => {
    if (activeUrl && !prevActiveUrl.current) {
      shouldSync().then(needed => {
        if (needed) {
          console.log('[useOfflineSearch] Backend URL became available — triggering sync');
          triggerSync(activeUrl);
        }
      });
    }
    prevActiveUrl.current = activeUrl;
  }, [activeUrl, triggerSync]);

  return { syncStatus, triggerSync };
}