// src/hooks/useOfflineSearch.js  — P3 + P4 + P5 full rewrite
//
// CHANGES FROM PREVIOUS VERSION:
//   P3 — syncFromServer() uses etag-based delta sync (304 = skip DB write)
//   P3 — replaceAllChunksWithVectors() called instead of replaceAllChunks()
//   P3 — vector_count persisted in sync_meta
//   P4 — localSearch() exported: embeds query on-device → hybridSearchChunks()
//   P5 — Effect 3: fixed-interval 10-min polling loop while server is reachable
//   P5 — triggerSync() accepts { force } option to bypass stale check
//   SYNC_STALE_MS aligned to POLL_INTERVAL_MS (both 10 min)
//
// EXPORTS:
//   useOfflineSearch(mode, activeUrl) — auto-sync hook (use in ChatScreen)
//   localSearch(query, topK)          — hybrid BM25+KNN search (use in useChat)

import { useState, useEffect, useRef, useCallback } from 'react';
import { NetworkMode }                from './useNetwork';
import {
  replaceAllChunksWithVectors,
  setSyncMeta,
  getSyncMeta,
  getChunkCount,
  getVectorCount,
  hybridSearchChunks,
}                                     from '../offline/db';
import { getEmbedder }                from '../offline/embedder';
import { syncPdfs }                   from '../offline/pdfSync';
import { apiFetch }                   from '../api/client';

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────

// P5: Both aligned so every poll tick actually syncs when data is new.
const SYNC_STALE_MS    = 10 * 60 * 1000; // 10 minutes
const POLL_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

// ─────────────────────────────────────────────────────────────
// P4: ON-DEVICE EMBEDDER (module-level singleton)
// ─────────────────────────────────────────────────────────────

let _embedder = null;

async function getLocalEmbedder() {
  if (_embedder) return _embedder;
  try {
    _embedder = await getEmbedder();
    console.log('[useOfflineSearch] On-device embedder ready');
  } catch (e) {
    // Not fatal — falls back to BM25-only search
    console.warn('[useOfflineSearch] Embedder unavailable, BM25 only:', e.message);
    _embedder = null;
  }
  return _embedder;
}

// ─────────────────────────────────────────────────────────────
// P4: localSearch — called by useChat.js in Mode 3
// ─────────────────────────────────────────────────────────────

/**
 * Hybrid local search: embeds the query on-device then calls hybridSearchChunks().
 * Falls back to BM25-only if the embedder is unavailable.
 *
 * @param {string} query  — raw user question
 * @param {number} topK   — number of results to return (default 5)
 * @returns {Promise<Array>} — ranked chunk objects with .score
 */
export async function localSearch(query, topK = 5) {
  let queryVec = null;
  try {
    const embedder = await getLocalEmbedder();
    if (embedder) queryVec = await embedder.embed(query);
  } catch (e) {
    console.warn('[useOfflineSearch] Embed failed, using BM25 only:', e.message);
  }

  return hybridSearchChunks(query, queryVec, topK);
}

// ─────────────────────────────────────────────────────────────
// STALE CHECK
// ─────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────
// P3: syncFromServer — etag delta + vector sync
// ─────────────────────────────────────────────────────────────

/**
 * Fetch chunks + vectors from /kb/export, store in SQLite, sync PDFs.
 *
 * Delta sync: sends the stored etag in If-None-Match header.
 * If the server returns 304, the chunk/vector sync is skipped entirely.
 * PDF sync always runs (PDFs tracked independently of the etag).
 *
 * @param {string} activeUrl — base URL from useNetwork.activeUrl
 */
async function syncFromServer(activeUrl) {
  // 1. Read stored etag for conditional request
  const storedEtag = await getSyncMeta('export_etag') || '';

  // 2. Fetch /kb/export (with vectors, with conditional header)
  const res = await apiFetch('/kb/export?include_vectors=true', activeUrl, {
    headers: storedEtag ? { 'If-None-Match': storedEtag } : {},
  });

  let chunksResult = { count: 0, vectors: 0, skipped: false };

  if (res.status === 304) {
    // Nothing changed on server — skip chunk + vector sync
    chunksResult.skipped = true;
    console.log('[SYNC] 304 Not Modified — chunks unchanged, skipping DB write');

  } else if (res.ok) {
    const data    = await res.json();
    const chunks  = data.chunks || [];
    const newEtag = data.etag || res.headers.get('X-Export-Etag') || '';

    // 3. Atomic replace: chunks + FTS + vectors
    await replaceAllChunksWithVectors(chunks);

    // 4. Persist new etag so next sync can delta-check
    if (newEtag) await setSyncMeta('export_etag', newEtag);

    chunksResult = {
      count:   chunks.length,
      vectors: chunks.filter(c => c.embedding).length,
      skipped: false,
    };

  } else {
    throw new Error(`/kb/export failed: ${res.status}`);
  }

  // 5. PDF sync — always runs (tracked independently of chunk etag)
  const pdfResult = await syncPdfs(activeUrl);

  // 6. Persist sync metadata
  await setSyncMeta('last_synced',  new Date().toISOString());
  await setSyncMeta('chunk_count',  String(await getChunkCount()));
  await setSyncMeta('vector_count', String(await getVectorCount()));

  return {
    chunks:        chunksResult.count,
    vectors:       chunksResult.vectors,
    chunksSkipped: chunksResult.skipped,
    pdfsSynced:    pdfResult.synced.length,
    pdfsDeleted:   pdfResult.deleted.length,
    errors:        pdfResult.errors,
  };
}

// ─────────────────────────────────────────────────────────────
// HOOK: useOfflineSearch
// ─────────────────────────────────────────────────────────────

/**
 * useOfflineSearch(mode, activeUrl)
 *
 * Automatically syncs local SQLite when:
 *   Effect 1: mode transitions from deep_offline → reachable
 *   Effect 2: activeUrl changes from empty → non-empty (first server contact)
 *   Effect 3 (P5): fixed 10-min polling while server is reachable
 *
 * Returns:
 *   syncStatus  — { isSyncing, lastSynced, chunkCount, vectorCount, lastResult }
 *   triggerSync — force an immediate sync (used by SettingsScreen manual button)
 */
export function useOfflineSearch(mode, activeUrl = '') {
  const [syncStatus, setSyncStatus] = useState({
    isSyncing:   false,
    lastSynced:  null,
    chunkCount:  0,
    vectorCount: 0,
    lastResult:  null,
  });

  const prevMode      = useRef(null);
  const prevActiveUrl = useRef('');
  const isSyncingRef  = useRef(false); // prevents concurrent syncs

  // Load persisted sync state on mount
  useEffect(() => {
    (async () => {
      try {
        const [lastSynced, count, vcount] = await Promise.all([
          getSyncMeta('last_synced'),
          getChunkCount(),
          getVectorCount(),
        ]);
        setSyncStatus(s => ({ ...s, lastSynced, chunkCount: count, vectorCount: vcount }));
      } catch { /* non-fatal */ }
    })();
  }, []);

  // P5: triggerSync accepts { force } to bypass stale check
  const triggerSync = useCallback(async (urlOverride, opts = {}) => {
    if (isSyncingRef.current) return;
    const url = urlOverride || activeUrl;
    if (!url) return;

    // Stale check unless force=true
    if (!opts.force) {
      const needed = await shouldSync();
      if (!needed) {
        console.log('[useOfflineSearch] Sync not needed (data is fresh)');
        return;
      }
    }

    isSyncingRef.current = true;
    setSyncStatus(s => ({ ...s, isSyncing: true }));

    try {
      const result = await syncFromServer(url);
      const [count, vcount] = await Promise.all([getChunkCount(), getVectorCount()]);
      setSyncStatus(s => ({
        ...s,
        isSyncing:   false,
        lastSynced:  new Date().toISOString(),
        chunkCount:  count,
        vectorCount: vcount,
        lastResult:  result,
      }));
      console.log(
        `[useOfflineSearch] Sync complete — ${result.chunks} chunks, ` +
        `${result.vectors} vectors, ${result.pdfsSynced} PDFs` +
        (result.chunksSkipped ? ' (304 — data unchanged)' : '')
      );
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

  // ── Effect 1: Sync on mode transition from deep_offline → reachable ──────
  useEffect(() => {
    const prev           = prevMode.current;
    const isNowReachable = (
      mode === NetworkMode.FULL_ONLINE ||
      mode === NetworkMode.INTRANET_ONLY
    );
    const wasOffline = (
      prev === NetworkMode.DEEP_OFFLINE ||
      prev === null // initial mount — treat as coming from offline
    );

    if (isNowReachable && wasOffline && activeUrl) {
      console.log('[useOfflineSearch] Mode became reachable — triggering sync');
      triggerSync(activeUrl);
    }

    prevMode.current = mode;
  }, [mode, activeUrl, triggerSync]);

  // ── Effect 2: Sync when activeUrl becomes available for first time ────────
  useEffect(() => {
    if (activeUrl && !prevActiveUrl.current) {
      console.log('[useOfflineSearch] Backend URL became available — triggering sync');
      triggerSync(activeUrl);
    }
    prevActiveUrl.current = activeUrl;
  }, [activeUrl, triggerSync]);

  // ── Effect 3 (P5): Fixed-interval polling while server is reachable ───────
  // 304 responses cost ~50 bytes — safe to poll every 10 minutes.
  useEffect(() => {
    const isReachable = (
      mode === NetworkMode.FULL_ONLINE ||
      mode === NetworkMode.INTRANET_ONLY
    );
    if (!isReachable || !activeUrl) return;

    const poll = () => {
      if (isSyncingRef.current) return; // already running, skip this tick
      console.log('[useOfflineSearch] Poll tick — checking for updates');
      triggerSync(activeUrl); // triggerSync itself checks shouldSync() internally
    };

    // First poll delayed by 60s — Effects 1/2 handle the immediate sync on connect
    const initialDelay = setTimeout(poll, 60_000);
    const interval     = setInterval(poll, POLL_INTERVAL_MS);

    return () => {
      clearTimeout(initialDelay);
      clearInterval(interval);
    };
  }, [mode, activeUrl, triggerSync]); // re-creates on mode/url change

  return { syncStatus, triggerSync };
}