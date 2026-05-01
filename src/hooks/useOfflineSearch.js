// src/hooks/useOfflineSearch.js
//
// CHANGES vs previous version:
//   FIX — result.vectors previously counted embeddings in the received JSON payload,
//         not what was actually stored in SQLite. The sync-complete log therefore
//         showed "340 vectors" while DB had 0 — the failure was invisible.
//         Now: vectors count comes from getVectorCount() AFTER the DB write, so
//         it reflects ground truth. result.vectors is removed entirely.
//
//   FIX — Pre-write embedding validation with detailed logging: logs shape, type,
//         and sample value of the first embedding before calling replaceAllChunksWithVectors.
//         This immediately surfaces any Float32Array / plain-array mismatch in db.js.
//
//   FIX — Sync-complete log now shows storedVectors (from DB) vs receivedVectors
//         (from JSON) side by side so any future storage loss is immediately visible.
//
//   FIX — syncFromServer returns storedVectors from getVectorCount() after write,
//         not a count derived from the payload.
//
//   KEPT — All P3/P4/P5 logic unchanged (etag delta, on-device embedder, polling).

import { useState, useEffect, useRef, useCallback } from 'react';
import { NetworkMode } from './useNetwork';
import {
  replaceAllChunksWithVectors,
  setSyncMeta,
  getSyncMeta,
  getChunkCount,
  getVectorCount,
  hybridSearchChunks,
} from '../offline/db';
import { getEmbedder } from '../offline/embedder';
import { syncPdfs } from '../offline/pdfSync';
import { getReranker } from '../offline/reranker';

const SYNC_STALE_MS    = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 10 * 60 * 1000;

// ─────────────────────────────────────────────────────────────
// P4: ON-DEVICE EMBEDDER (module-level singleton)
// ─────────────────────────────────────────────────────────────

let _embedder = null;
let _reranker = null;

async function getLocalEmbedder() {
  if (_embedder) return _embedder;
  try {
    _embedder = await getEmbedder();
    console.log('[useOfflineSearch] On-device embedder ready');
  } catch (e) {
    console.warn('[useOfflineSearch] Embedder unavailable, BM25 only:', e.message);
    _embedder = null;
  }
  return _embedder;
}

// ─────────────────────────────────────────────────────────────
// P4: localSearch — called by useChat.js in Mode 3
// ─────────────────────────────────────────────────────────────

async function getLocalReranker() {
  if (_reranker) return _reranker;
  try {
    _reranker = await getReranker();
    console.log('[useOfflineSearch] Cross-encoder reranker ready');
  } catch (e) {
    console.warn('[useOfflineSearch] Reranker unavailable:', e.message);
    _reranker = null;
  }
  return _reranker;
}

// ─── replace localSearch entirely ────────────────────────────
export async function localSearch(query, topK = 5) {
  // Step 1 — embed query for KNN
  let queryVec = null;
  try {
    const embedder = await getLocalEmbedder();
    if (embedder) queryVec = await embedder.embed(query);
  } catch (e) {
    console.warn('[useOfflineSearch] Embed failed, BM25 only:', e.message);
  }

  // Step 2 — hybrid retrieve: get more candidates than topK
  //          so the reranker has material to work with
  const RETRIEVE_K = Math.max(topK * 4, 20);  // e.g. topK=5 → fetch 20
  const candidates = await hybridSearchChunks(query, queryVec, RETRIEVE_K);

  // Step 3 — rerank if available, then slice to topK
  try {
    const reranker = await getLocalReranker();
    if (reranker && candidates.length > 0) {
      const reranked = await reranker.rerank(query, candidates);
      return reranked.slice(0, topK);
    }
  } catch (e) {
    console.warn('[useOfflineSearch] Reranker failed, using RRF order:', e.message);
  }

  // Fallback: return RRF-ordered results without reranking
  return candidates.slice(0, topK);
}

// ─────────────────────────────────────────────────────────────
// STALE CHECK
// ─────────────────────────────────────────────────────────────

async function shouldSync() {
  try {
    const lastSynced = await getSyncMeta('last_synced');
    if (!lastSynced) return true;
    return Date.now() - new Date(lastSynced).getTime() > SYNC_STALE_MS;
  } catch {
    return true;
  }
}

// ─────────────────────────────────────────────────────────────
// EMBEDDING VALIDATOR
// Logs the shape of what's about to be written to SQLite so any
// Float32Array / plain-array mismatch in db.js is immediately visible.
// ─────────────────────────────────────────────────────────────

function validateAndLogEmbeddings(chunks) {
  const withEmbedding = chunks.filter(c => c.embedding != null);
  const without       = chunks.length - withEmbedding.length;

  console.log(
    `[SYNC/validate] ${chunks.length} chunks total — ` +
    `${withEmbedding.length} have embedding, ${without} do not`
  );

  if (withEmbedding.length === 0) {
    console.warn('[SYNC/validate] ⚠ No embeddings in payload — server may not be sending vectors');
    return;
  }

  // Inspect first embedding for type/shape issues
  const first = withEmbedding[0].embedding;
  console.log(
    `[SYNC/validate] First embedding — ` +
    `type=${Object.prototype.toString.call(first)}, ` +
    `length=${first?.length}, ` +
    `isArray=${Array.isArray(first)}, ` +
    `isFloat32=${first instanceof Float32Array}, ` +
    `sample=[${Array.isArray(first) ? first.slice(0, 3).map(v => v.toFixed(4)).join(', ') : 'n/a'}]`
  );

  // Warn if it's a plain array — db.js MUST convert to Float32Array before
  // inserting into sqlite-vec, otherwise the write silently drops the vector.
  if (Array.isArray(first)) {
    console.warn(
      '[SYNC/validate] ⚠ Embeddings are plain JS arrays. ' +
      'db.js must call new Float32Array(embedding).buffer before sqlite-vec insert. ' +
      'If not done, vectors will be stored as 0.'
    );
  }
}

// ─────────────────────────────────────────────────────────────
// P3: syncFromServer — etag delta + vector sync
// ─────────────────────────────────────────────────────────────

async function syncFromServer(activeUrl) {
  const storedEtag = await getSyncMeta('export_etag') || '';

  const res = await fetch(`${activeUrl}/kb/export?include_vectors=true`, {
    headers: {
      'Content-Type': 'application/json',
      ...(storedEtag ? { 'If-None-Match': storedEtag } : {}),
    },
  });

  let chunksSkipped = false;
  let receivedChunks = 0;
  let receivedVectors = 0; // count from JSON payload (what server sent)

  if (res.status === 304) {
    chunksSkipped = true;
    console.log('[SYNC] 304 Not Modified — chunks unchanged, skipping DB write');

  } else if (res.ok) {
    const data   = await res.json();
    const chunks = data.chunks || [];
    const newEtag = data.etag || res.headers.get('X-Export-Etag') || '';

    receivedChunks  = chunks.length;
    // FIX: this only counts what arrived — does NOT mean they were stored correctly
    receivedVectors = chunks.filter(c => Array.isArray(c.embedding) && c.embedding.length > 0).length;

    console.log(`[SYNC] Received ${receivedChunks} chunks, ${receivedVectors} with embeddings from server`);

    // Validate embedding shape BEFORE writing — surfaces db.js Float32Array issues
    validateAndLogEmbeddings(chunks);

    // Atomic replace: chunks + FTS + vectors
    // db.js MUST convert embedding: number[] → Float32Array buffer for sqlite-vec
    await replaceAllChunksWithVectors(chunks);

    if (newEtag) await setSyncMeta('export_etag', newEtag);

  } else {
    throw new Error(`/kb/export failed: HTTP ${res.status}`);
  }

  // PDF sync — always runs regardless of chunk etag
  const pdfResult = await syncPdfs(activeUrl);

  // Read actual stored counts from DB — ground truth after the write
  // FIX: use these values, not the received counts, for reporting
  const [storedChunks, storedVectors] = await Promise.all([
    getChunkCount(),
    getVectorCount(),
  ]);

  // Persist sync metadata
  await setSyncMeta('last_synced',  new Date().toISOString());
  await setSyncMeta('chunk_count',  String(storedChunks));
  await setSyncMeta('vector_count', String(storedVectors));

  // FIX: log received vs stored side by side — any mismatch = db.js write bug
  if (!chunksSkipped) {
    console.log(
      `[SYNC] DB write complete — ` +
      `chunks: received=${receivedChunks} stored=${storedChunks} | ` +
      `vectors: received=${receivedVectors} stored=${storedVectors}`
    );

    if (receivedVectors > 0 && storedVectors === 0) {
      console.error(
        '[SYNC] ✗ Vector storage failure — received embeddings but stored 0. ' +
        'Fix: in db.js replaceAllChunksWithVectors(), convert embedding to ' +
        'new Float32Array(chunk.embedding).buffer before inserting into vec_chunks.'
      );
    } else if (storedVectors < receivedVectors) {
      console.warn(
        `[SYNC] ⚠ Partial vector loss — received ${receivedVectors}, stored ${storedVectors}. ` +
        `Check for per-row errors in replaceAllChunksWithVectors().`
      );
    } else {
      console.log(`[SYNC] ✅ Vectors stored correctly (${storedVectors}/${receivedVectors})`);
    }
  }

  return {
    chunks:        storedChunks,   // FIX: ground truth from DB, not JSON payload count
    vectors:       storedVectors,  // FIX: ground truth from DB, not JSON payload count
    chunksSkipped,
    pdfsSynced:    pdfResult.synced.length,
    pdfsDeleted:   pdfResult.deleted.length,
    errors:        pdfResult.errors,
  };
}

// ─────────────────────────────────────────────────────────────
// HOOK: useOfflineSearch
// ─────────────────────────────────────────────────────────────

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
  const isSyncingRef  = useRef(false);

  // Load persisted state on mount
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

  const triggerSync = useCallback(async (urlOverride, opts = {}) => {
    if (isSyncingRef.current) return;
    const url = urlOverride || activeUrl;
    if (!url) return;

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

      // FIX: result.chunks and result.vectors are now DB ground-truth values
      setSyncStatus(s => ({
        ...s,
        isSyncing:   false,
        lastSynced:  new Date().toISOString(),
        chunkCount:  result.chunks,
        vectorCount: result.vectors,
        lastResult:  result,
      }));

      // FIX: log shows stored counts, not received counts
      console.log(
        `[useOfflineSearch] Sync complete — ` +
        `${result.chunks} chunks, ${result.vectors} vectors, ` +
        `${result.pdfsSynced} PDFs` +
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

  // Effect 1: mode transition deep_offline → reachable
  useEffect(() => {
    const prev          = prevMode.current;
    const isNowReachable = mode === NetworkMode.FULL_ONLINE || mode === NetworkMode.INTRANET_ONLY;
    const wasOffline     = prev === NetworkMode.DEEP_OFFLINE || prev === null;

    if (isNowReachable && wasOffline && activeUrl) {
      console.log('[useOfflineSearch] Mode became reachable — triggering sync');
      triggerSync(activeUrl);
    }
    prevMode.current = mode;
  }, [mode, activeUrl, triggerSync]);

  // Effect 2: activeUrl first becomes available
  useEffect(() => {
    if (activeUrl && !prevActiveUrl.current) {
      console.log('[useOfflineSearch] Backend URL became available — triggering sync');
      triggerSync(activeUrl);
    }
    prevActiveUrl.current = activeUrl;
  }, [activeUrl, triggerSync]);

  // Effect 3: 10-min polling while reachable
  useEffect(() => {
    const isReachable = mode === NetworkMode.FULL_ONLINE || mode === NetworkMode.INTRANET_ONLY;
    if (!isReachable || !activeUrl) return;

    const poll = () => {
      if (isSyncingRef.current) return;
      console.log('[useOfflineSearch] Poll tick — checking for updates');
      triggerSync(activeUrl);
    };

    const initialDelay = setTimeout(poll, 60_000);
    const interval     = setInterval(poll, POLL_INTERVAL_MS);
    return () => { clearTimeout(initialDelay); clearInterval(interval); };
  }, [mode, activeUrl, triggerSync]);

  return { syncStatus, triggerSync };
}