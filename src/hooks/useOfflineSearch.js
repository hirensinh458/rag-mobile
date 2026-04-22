// src/hooks/useOfflineSearch.js
//
// Hook that combines local SQLite search + sync orchestration.
// Used by useChat in Mode 3 (DEEP_OFFLINE) and the Settings screen.
//
// WHAT IT DOES:
//   - On mount: checks if sync is needed and triggers it automatically
//   - When mode transitions to ONLINE/LAN_ONLY: syncs from server
//   - Exposes localSearch(query) for Mode 3 chat queries
//   - Exposes syncStatus for the Settings screen

import { useState, useEffect, useCallback, useRef } from 'react';
import { NetworkMode }         from './useNetwork';
import { searchChunks }        from '../offline/db';
import {
  syncFromServer,
  shouldSync,
  getSyncStatus,
  onSyncStatusChange,
  cancelPendingSync,
}                              from '../offline/syncQueue';

// ─────────────────────────────────────────────────────────────
// HOOK
// ─────────────────────────────────────────────────────────────

/**
 * @param {string} mode — current NetworkMode from useNetwork()
 */
export function useOfflineSearch(mode) {
  const [syncStatus, setSyncStatus] = useState({
    lastSynced:  null,
    chunkCount:  0,
    localCount:  0,
    isSyncing:   false,
    phase:       'idle',
    error:       null,
  });

  const prevMode = useRef(mode);

  // Load initial sync status from DB on mount
  useEffect(() => {
    getSyncStatus().then(s => setSyncStatus(prev => ({ ...prev, ...s })));

    // Subscribe to real-time sync progress from syncQueue
    onSyncStatusChange(update => {
      setSyncStatus(prev => ({
        ...prev,
        isSyncing:  update.syncing    ?? prev.isSyncing,
        phase:      update.phase      ?? prev.phase,
        chunkCount: update.chunkCount ?? prev.chunkCount,
        lastSynced: update.lastSynced ?? prev.lastSynced,
        error:      update.error      ?? null,
      }));
    });

    return () => {
      onSyncStatusChange(null);
      cancelPendingSync();
    };
  }, []);

  // Auto-sync when mode transitions TO online from deep offline
  // Also auto-sync on initial online mount if needed
  useEffect(() => {
    const wasDeepOffline = prevMode.current === NetworkMode.DEEP_OFFLINE;
    const isNowReachable = mode === NetworkMode.ONLINE || mode === NetworkMode.LAN_ONLY;

    if (isNowReachable && (wasDeepOffline || prevMode.current === null)) {
      // Came back online — check if sync is needed
      shouldSync().then(needed => {
        if (needed) {
          console.log('[useOfflineSearch] Mode back online — triggering sync');
          triggerSync();
        }
      });
    }

    prevMode.current = mode;
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── LOCAL SEARCH ───────────────────────────────────────────
  /**
   * Search local SQLite database using FTS5 BM25 ranking.
   * Called by useChat in Mode 3 (deep offline).
   *
   * Returns an array of chunk objects shaped like the server's /chat/offline
   * response, so the MessageBubble rendering works identically.
   */
  const localSearch = useCallback(async (query, topK = 5) => {
    const chunks = await searchChunks(query, topK);

    // Shape matches OfflineChunk from the backend schemas
    return chunks.map((c, i) => ({
      id:       c.id || i,
      source:   c.source,
      content:  c.content,
      page:     c.page,
      type:     c.chunk_type || 'text',
      score:    c.score,
      rank:     i + 1,
    }));
  }, []);

  // ── MANUAL SYNC ────────────────────────────────────────────
  const triggerSync = useCallback(async () => {
    if (syncStatus.isSyncing) return;
    const result = await syncFromServer();
    if (result.success) {
      const fresh = await getSyncStatus();
      setSyncStatus(prev => ({ ...prev, ...fresh, phase: 'idle', error: null }));
    }
  }, [syncStatus.isSyncing]);

  return {
    localSearch,   // (query: string, topK?: number) => Promise<chunk[]>
    triggerSync,   // () => Promise<void>  — call from Settings "Sync now" button
    syncStatus,    // { lastSynced, chunkCount, localCount, isSyncing, phase, error }
  };
}