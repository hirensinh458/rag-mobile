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
//
// LOGGING ADDED: Every stage of the sync pipeline (URL read, /kb/export request,
// etag check, chunk/vector counts, DB write, PDF sync, polling), every localSearch()
// step (embed, BM25+KNN, rerank), and every mode/URL transition trigger is logged
// via createLogger('useOfflineSearch').

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
import { syncPdfs }    from '../offline/pdfSync';
import { getReranker } from '../offline/reranker';
import { createLogger } from '../utils/logger';

// Module-level logger — all lines tagged [useOfflineSearch]
const log = createLogger('useOfflineSearch');

const SYNC_STALE_MS    = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 10 * 60 * 1000;

// ─────────────────────────────────────────────────────────────
// P4: ON-DEVICE EMBEDDER (module-level singleton)
// ─────────────────────────────────────────────────────────────

let _embedder = null;
let _reranker = null;

async function getLocalEmbedder() {
  if (_embedder) {
    log.debug('getLocalEmbedder() → returning cached embedder');
    return _embedder;
  }
  log.info('getLocalEmbedder() → initialising on-device embedder …');
  try {
    _embedder = await getEmbedder();
    log.info('getLocalEmbedder() ✅ On-device embedder ready');
  } catch (e) {
    log.warn('getLocalEmbedder() ⚠ Embedder unavailable — BM25 only:', e.message);
    _embedder = null;
  }
  return _embedder;
}

async function getLocalReranker() {
  if (_reranker) {
    log.debug('getLocalReranker() → returning cached reranker');
    return _reranker;
  }
  log.info('getLocalReranker() → initialising cross-encoder reranker …');
  try {
    _reranker = await getReranker();
    log.info('getLocalReranker() ✅ Cross-encoder reranker ready');
  } catch (e) {
    log.warn('getLocalReranker() ⚠ Reranker unavailable:', e.message);
    _reranker = null;
  }
  return _reranker;
}

// ─────────────────────────────────────────────────────────────
// P4: localSearch — called by useChat.js in Mode 3
// ─────────────────────────────────────────────────────────────

export async function localSearch(query, topK = 5) {
  log.info('localSearch() START', { query: query.slice(0, 100), topK });
  const startMs = Date.now();

  // Step 1 — embed query for KNN
  let queryVec = null;
  try {
    log.debug('localSearch() STEP 1 — embedding query on-device …');
    const embedder = await getLocalEmbedder();
    if (embedder) {
      queryVec = await embedder.embed(query);
      log.info('localSearch() STEP 1 ✅ query embedded — dim:', queryVec?.length);
    } else {
      log.warn('localSearch() STEP 1 ⚠ No embedder — KNN disabled, BM25 only');
    }
  } catch (e) {
    log.warn('localSearch() STEP 1 embed FAILED (BM25 only):', e.message);
  }

  // Step 2 — hybrid retrieve: get more candidates than topK
  //          so the reranker has material to work with
  const RETRIEVE_K = Math.max(topK * 2, 10);  // e.g. topK=5 → fetch 20
  log.info('localSearch() STEP 2 — hybridSearchChunks()', {
    query: query.slice(0, 80),
    hasQueryVec: queryVec !== null,
    RETRIEVE_K,
  });

  const candidates = await hybridSearchChunks(query, queryVec, RETRIEVE_K);
  log.info('localSearch() STEP 2 ✅ hybridSearchChunks returned', candidates.length,
    'candidates in', Date.now() - startMs, 'ms');

  if (candidates.length === 0) {
    log.warn('localSearch() no candidates found — returning empty results');
    return [];
  }

  // Step 3 — rerank if available, then slice to topK
  // try {
  //   log.debug('localSearch() STEP 3 — loading reranker …');
  //   const reranker = await getLocalReranker();
  //   if (reranker && candidates.length > 0) {
  //     log.info('localSearch() STEP 3 — reranking', candidates.length, 'candidates …');
  //     const reranked = await reranker.rerank(query, candidates);
  //     const result   = reranked.slice(0, topK);
  //     log.info('localSearch() STEP 3 ✅ reranked — returning top', result.length,
  //       'in', Date.now() - startMs, 'ms total |',
  //       result.map(c => `${c.source}:p${c.page}(${c.rerankerScore?.toFixed(3) ?? c.score?.toFixed(3)})`).join(', '));
  //     return result;
  //   } else {
  //     log.warn('localSearch() STEP 3 ⚠ Reranker unavailable — using RRF order');
  //   }
  // } catch (e) {
  //   log.warn('localSearch() STEP 3 reranker FAILED — using RRF order:', e.message);
  // }

  // Fallback: return RRF-ordered results without reranking
  const result = candidates.slice(0, topK);
  log.info('localSearch() COMPLETE (no reranker) — returning', result.length,
    'in', Date.now() - startMs, 'ms total');
  return result;
}

// ─────────────────────────────────────────────────────────────
// STALE CHECK
// ─────────────────────────────────────────────────────────────

async function shouldSync() {
  try {
    const lastSynced = await getSyncMeta('last_synced');
    if (!lastSynced) {
      log.info('shouldSync() → true (never synced)');
      return true;
    }
    const ageMs  = Date.now() - new Date(lastSynced).getTime();
    const stale  = ageMs > SYNC_STALE_MS;
    log.info('shouldSync() →', stale ? 'true (stale)' : 'false (fresh)',
      `| last synced: ${lastSynced} | age: ${Math.round(ageMs / 1000)}s`);
    return stale;
  } catch (err) {
    log.warn('shouldSync() error reading sync_meta:', err.message, '→ defaulting to true');
    return true;
  }
}

// ─────────────────────────────────────────────────────────────
// EMBEDDING VALIDATOR
// ─────────────────────────────────────────────────────────────

function validateAndLogEmbeddings(chunks) {
  const withEmbedding = chunks.filter(c => c.embedding != null);
  const without       = chunks.length - withEmbedding.length;

  log.info(
    `validateAndLogEmbeddings() ${chunks.length} chunks total — ` +
    `${withEmbedding.length} have embedding, ${without} do not`,
  );

  if (withEmbedding.length === 0) {
    log.warn('validateAndLogEmbeddings() ⚠ No embeddings in payload — server may not be sending vectors');
    return;
  }

  const first = withEmbedding[0].embedding;
  log.info(
    'validateAndLogEmbeddings() first embedding —',
    `type=${Object.prototype.toString.call(first)},`,
    `length=${first?.length},`,
    `isArray=${Array.isArray(first)},`,
    `isFloat32=${first instanceof Float32Array},`,
    `sample=[${Array.isArray(first) ? first.slice(0, 3).map(v => v.toFixed(4)).join(', ') : 'n/a'}]`,
  );

  if (Array.isArray(first)) {
    log.warn(
      'validateAndLogEmbeddings() ⚠ Embeddings are plain JS arrays. ' +
      'db.js must call new Float32Array(embedding).buffer before sqlite-vec insert. ' +
      'If not done, vectors will be stored as 0.',
    );
  }
}

// ─────────────────────────────────────────────────────────────
// P3: syncFromServer — etag delta + vector sync
// ─────────────────────────────────────────────────────────────

async function syncFromServer(activeUrl) {
  log.info('syncFromServer() START → activeUrl:', activeUrl);

  const storedEtag = await getSyncMeta('export_etag') || '';
  log.debug('syncFromServer() stored etag:', storedEtag || '(none)');

  const exportUrl = `${activeUrl}/kb/export?include_vectors=true`;
  log.info('syncFromServer() → GET', exportUrl,
    storedEtag ? `(If-None-Match: ${storedEtag})` : '(no etag)');

  const startMs = Date.now();

  const res = await fetch(exportUrl, {
    headers: {
      'Content-Type': 'application/json',
      ...(storedEtag ? { 'If-None-Match': storedEtag } : {}),
    },
  });

  log.info('syncFromServer() /kb/export response:', res.status,
    '| elapsed:', Date.now() - startMs, 'ms');

  let chunksSkipped   = false;
  let receivedChunks  = 0;
  let receivedVectors = 0;

  if (res.status === 304) {
    chunksSkipped = true;
    log.info('syncFromServer() 304 Not Modified — chunks unchanged, skipping DB write');

  } else if (res.ok) {
    const data    = await res.json();
    const chunks  = data.chunks || [];
    const newEtag = data.etag || res.headers.get('X-Export-Etag') || '';

    receivedChunks  = chunks.length;
    receivedVectors = chunks.filter(
      c => Array.isArray(c.embedding) && c.embedding.length > 0
    ).length;

    log.info(`syncFromServer() received ${receivedChunks} chunks, ${receivedVectors} with embeddings`);
    if (newEtag) log.debug('syncFromServer() new etag from server:', newEtag);

    // Validate embedding shape BEFORE writing
    validateAndLogEmbeddings(chunks);

    log.info('syncFromServer() → replaceAllChunksWithVectors() writing to SQLite …');
    const dbStartMs = Date.now();
    await replaceAllChunksWithVectors(chunks);
    log.info('syncFromServer() DB write complete in', Date.now() - dbStartMs, 'ms');

    if (newEtag) await setSyncMeta('export_etag', newEtag);

  } else {
    log.error(`syncFromServer() /kb/export FAILED: HTTP ${res.status}`);
    throw new Error(`/kb/export failed: HTTP ${res.status}`);
  }

  // PDF sync — always runs regardless of chunk etag
  log.info('syncFromServer() → syncPdfs() starting …');
  const pdfStartMs = Date.now();
  const pdfResult  = await syncPdfs(activeUrl);
  log.info('syncFromServer() syncPdfs() DONE in', Date.now() - pdfStartMs, 'ms', {
    synced:  pdfResult.synced.length,
    deleted: pdfResult.deleted.length,
    errors:  pdfResult.errors.length,
  });
  if (pdfResult.errors.length) {
    log.warn('syncFromServer() PDF sync errors:', pdfResult.errors);
  }

  // Read actual stored counts from DB — ground truth after the write
  const [storedChunks, storedVectors] = await Promise.all([
    getChunkCount(),
    getVectorCount(),
  ]);

  log.info('syncFromServer() DB ground-truth counts:', {
    storedChunks,
    storedVectors,
    receivedChunks,
    receivedVectors,
  });

  // Persist sync metadata
  await setSyncMeta('last_synced',  new Date().toISOString());
  await setSyncMeta('chunk_count',  String(storedChunks));
  await setSyncMeta('vector_count', String(storedVectors));

  if (!chunksSkipped) {
    if (receivedVectors > 0 && storedVectors === 0) {
      log.error(
        'syncFromServer() ✗ VECTOR STORAGE FAILURE — received', receivedVectors,
        'but stored 0. Fix: in db.js replaceAllChunksWithVectors(), convert embedding to ' +
        'new Float32Array(chunk.embedding).buffer before inserting into vec_chunks.',
      );
    } else if (storedVectors < receivedVectors) {
      log.warn(
        `syncFromServer() ⚠ Partial vector loss — received ${receivedVectors}, stored ${storedVectors}.`,
        'Check for per-row errors in replaceAllChunksWithVectors().',
      );
    } else {
      log.info(`syncFromServer() ✅ Vectors stored correctly (${storedVectors}/${receivedVectors})`);
    }
  }

  log.info('syncFromServer() COMPLETE — total time:', Date.now() - startMs, 'ms', {
    storedChunks,
    storedVectors,
    chunksSkipped,
    pdfsSynced:  pdfResult.synced.length,
    pdfsDeleted: pdfResult.deleted.length,
  });

  return {
    chunks:        storedChunks,
    vectors:       storedVectors,
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
    log.info('useOfflineSearch() MOUNT — loading persisted sync metadata …');
    (async () => {
      try {
        const [lastSynced, count, vcount] = await Promise.all([
          getSyncMeta('last_synced'),
          getChunkCount(),
          getVectorCount(),
        ]);
        log.info('useOfflineSearch() persisted state loaded:', {
          lastSynced: lastSynced || '(never)',
          chunkCount: count,
          vectorCount: vcount,
        });
        setSyncStatus(s => ({ ...s, lastSynced, chunkCount: count, vectorCount: vcount }));
      } catch (err) {
        log.warn('useOfflineSearch() failed to load persisted state:', err.message);
      }
    })();
  }, []);

  const triggerSync = useCallback(async (urlOverride, opts = {}) => {
    if (isSyncingRef.current) {
      log.warn('triggerSync() SKIPPED — sync already in progress');
      return;
    }

    const url = urlOverride || activeUrl;
    if (!url) {
      log.warn('triggerSync() SKIPPED — no URL available');
      return;
    }

    if (!opts.force) {
      const needed = await shouldSync();
      if (!needed) {
        log.info('triggerSync() SKIPPED — data is fresh (within 10 min)');
        return;
      }
    } else {
      log.info('triggerSync() force=true — bypassing stale check');
    }

    log.info('triggerSync() START — url:', url, '| force:', opts.force ?? false);

    isSyncingRef.current = true;
    setSyncStatus(s => ({ ...s, isSyncing: true }));

    try {
      const result = await syncFromServer(url);

      setSyncStatus(s => ({
        ...s,
        isSyncing:   false,
        lastSynced:  new Date().toISOString(),
        chunkCount:  result.chunks,
        vectorCount: result.vectors,
        lastResult:  result,
      }));

      log.info('triggerSync() ✅ COMPLETE', {
        chunks:        result.chunks,
        vectors:       result.vectors,
        pdfsSynced:    result.pdfsSynced,
        chunksSkipped: result.chunksSkipped,
      });

    } catch (err) {
      log.error('triggerSync() ✗ FAILED:', err.message, err);
      setSyncStatus(s => ({
        ...s,
        isSyncing:  false,
        lastResult: { error: err.message },
      }));
    } finally {
      isSyncingRef.current = false;
      log.debug('triggerSync() isSyncingRef reset to false');
    }
  }, [activeUrl]);

  // Effect 1: mode transition deep_offline → reachable
  useEffect(() => {
    const prev           = prevMode.current;
    const isNowReachable = mode === NetworkMode.FULL_ONLINE || mode === NetworkMode.INTRANET_ONLY;
    const wasOffline     = prev === NetworkMode.DEEP_OFFLINE || prev === null;

    log.debug('useOfflineSearch() Effect 1 (mode change):', {
      prev:            prev ?? 'null (initial)',
      current:         mode,
      isNowReachable,
      wasOffline,
      activeUrl:       activeUrl || '(none)',
    });

    if (isNowReachable && wasOffline && activeUrl) {
      log.info('useOfflineSearch() Effect 1 → mode became reachable — triggering sync');
      triggerSync(activeUrl);
    }
    prevMode.current = mode;
  }, [mode, activeUrl, triggerSync]);

  // Effect 2: activeUrl first becomes available
  useEffect(() => {
    log.debug('useOfflineSearch() Effect 2 (activeUrl change):', {
      activeUrl: activeUrl || '(none)',
      prev:      prevActiveUrl.current || '(none)',
    });

    if (activeUrl && !prevActiveUrl.current) {
      log.info('useOfflineSearch() Effect 2 → backend URL became available — triggering sync');
      triggerSync(activeUrl);
    }
    prevActiveUrl.current = activeUrl;
  }, [activeUrl, triggerSync]);

  // Effect 3: 10-min polling while reachable
  useEffect(() => {
    const isReachable = mode === NetworkMode.FULL_ONLINE || mode === NetworkMode.INTRANET_ONLY;

    if (!isReachable || !activeUrl) {
      log.debug('useOfflineSearch() Effect 3 (poll) — skipping setup (not reachable or no url)');
      return;
    }

    log.info('useOfflineSearch() Effect 3 — setting up 10-min poll for:', activeUrl);

    const poll = () => {
      if (isSyncingRef.current) {
        log.debug('useOfflineSearch() poll tick — sync already running, skipping');
        return;
      }
      log.info('useOfflineSearch() poll tick — checking for updates …');
      triggerSync(activeUrl);
    };

    const initialDelay = setTimeout(() => {
      log.debug('useOfflineSearch() poll — initial 60s delay fired');
      poll();
    }, 60_000);

    const interval = setInterval(() => {
      log.debug('useOfflineSearch() poll — interval fired');
      poll();
    }, POLL_INTERVAL_MS);

    return () => {
      log.info('useOfflineSearch() Effect 3 (poll) — cleaning up');
      clearTimeout(initialDelay);
      clearInterval(interval);
    };
  }, [mode, activeUrl, triggerSync]);

  return { syncStatus, triggerSync };
}