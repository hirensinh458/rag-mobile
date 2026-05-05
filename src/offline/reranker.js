// src/offline/reranker.js
//
// Cross-encoder reranker using ms-marco-TinyBERT-L-2-v2.
// Takes a query + array of {chunk} objects, returns them
// re-sorted by relevance score descending.
//
// Input format:  [CLS] query [SEP] chunk [SEP]
// Output:        single logit shape [batch, 1] — higher = more relevant
// Vocab:         same 30522-token BERT vocab as BGE-small ✓
//
// HOW THE MODEL GETS INTO THE APK:
//   1. pre-install.sh downloads reranker.onnx → assets/models/reranker.onnx
//   2. withModelAssets.js (Expo config plugin) copies it to
//      android/app/src/main/assets/models/reranker.onnx at build time
//   3. At runtime, FileSystem.copyAsync({ from: 'asset:///models/reranker.onnx' })
//      reads it from the APK's native assets folder — no Metro, no server
//
// WHY -4.875 WAS HAPPENING:
//   _getModelPath() had no size check after copyAsync. On some Android devices,
//   copyAsync from 'asset:///' silently produces a 0-byte or corrupt file without
//   throwing. createModelLoader() loaded the corrupt file and the ONNX runtime
//   output a constant bias (-4.875) from uninitialised weights.
//   FIX: verify size > 15 MB after every copy. If corrupt, delete and retry.
//
// MODEL_VERSION: bump this string whenever pre-install.sh downloads a new model.
// It changes the cached filename, which forces a fresh copy from the APK on the
// next cold start — busting any stale corrupt cache automatically.

import * as FileSystem from 'expo-file-system/legacy';
import { createModelLoader } from 'react-native-nitro-onnxruntime';
import { tokenize } from './tokenizer';
import { createLogger } from '../utils/logger';

// Module-level logger — all lines tagged [reranker]
const log = createLogger('reranker');

// ─────────────────────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────────────────────

// Bump this whenever pre-install.sh downloads a new model.
// Changes the cached filename → forces fresh copy from APK on next cold start.
const MODEL_VERSION = 'tinybert-l2-v2';

// ─────────────────────────────────────────────────────────────
// CONSTANTS (BERT special token IDs)
// ─────────────────────────────────────────────────────────────

const CLS_ID     = 101;
const SEP_ID     = 102;
const PAD_ID     = 0;
const MAX_LENGTH = 512;

// ─────────────────────────────────────────────────────────────
// SESSION SINGLETON
// ─────────────────────────────────────────────────────────────

let _session     = null;
let _sessionInit = null;

/**
 * _getModelPath()
 *
 * Copies reranker.onnx from the APK native assets to a writable cache file.
 * Uses a version-stamped filename so bumping MODEL_VERSION forces a fresh copy.
 * Verifies file size after every copy — if corrupt (0 bytes), deletes and throws
 * so the caller can retry rather than loading broken weights silently.
 *
 * URI 'asset:///models/reranker.onnx' is resolved by Android's AssetManager
 * directly from the APK at runtime. No Metro bundler, no local dev server.
 * This works because withModelAssets.js copies the file into
 * android/app/src/main/assets/models/ during the EAS build.
 */
async function _getModelPath() {
  const dest = `${FileSystem.documentDirectory}reranker_${MODEL_VERSION}.onnx`;

  log.info('_getModelPath() — MODEL_VERSION:', MODEL_VERSION);
  log.debug('_getModelPath() — cache path:', dest);

  // ── Check existing cache ──────────────────────────────────────────────────
  const info = await FileSystem.getInfoAsync(dest);

  if (info.exists && info.size > 15_000_000) {
    // Valid — skip copy
    log.info(
      `_getModelPath() ✅ valid cache hit — ${(info.size / 1e6).toFixed(1)} MB`,
      '| path:', dest,
    );
    return dest;
  }

  if (info.exists) {
    // Exists but too small — corrupt copy from a previous run, delete it
    log.warn(
      `_getModelPath() ⚠ corrupt cache (${info.size ?? 0} bytes < 15 MB) — deleting`,
    );
    await FileSystem.deleteAsync(dest, { idempotent: true });
  }

  // ── Delete old versioned files to free disk space ─────────────────────────
  try {
    const docDir   = FileSystem.documentDirectory;
    const allFiles = await FileSystem.readDirectoryAsync(docDir);
    const oldFiles = allFiles.filter(
      f => f.startsWith('reranker_') && f.endsWith('.onnx'),
    );
    for (const old of oldFiles) {
      log.info('_getModelPath() 🗑 removing old version:', old);
      await FileSystem.deleteAsync(docDir + old, { idempotent: true });
    }
    if (oldFiles.length === 0) {
      log.debug('_getModelPath() — no old versions to clean up');
    }
  } catch (cleanErr) {
    // Non-fatal — proceed with copy even if cleanup fails
    log.warn('_getModelPath() cleanup error (non-fatal):', cleanErr.message);
  }

  // ── Copy from APK native assets ───────────────────────────────────────────
  // 'asset:///models/reranker.onnx' is served by Android AssetManager from
  // android/app/src/main/assets/models/reranker.onnx inside the APK.
  // withModelAssets.js placed it there at EAS build time.
  const apkUri  = 'asset:///models/reranker.onnx';
  const copyStart = Date.now();

  log.info('_getModelPath() — copying from APK assets:', apkUri, '→', dest);

  await FileSystem.copyAsync({ from: apkUri, to: dest });

  const elapsed = Date.now() - copyStart;

  // ── Verify copy succeeded and is a real file ──────────────────────────────
  const verify = await FileSystem.getInfoAsync(dest);

  if (!verify.exists || verify.size < 15_000_000) {
    // copyAsync did not throw but produced a corrupt/empty file.
    // Delete it so the next cold start retries the copy.
    await FileSystem.deleteAsync(dest, { idempotent: true });

    log.error(
      `_getModelPath() ✗ copy produced corrupt file`,
      `(exists=${verify.exists} size=${verify.size ?? 0} bytes)`,
      '\n  Possible causes:',
      '\n    1. withModelAssets.js did not run — check EAS build log for "[withModelAssets]" lines',
      '\n    2. pre-install.sh failed — check EAS build log for "[pre-install]" lines',
      '\n    3. Android AssetManager could not find "models/reranker.onnx" in APK',
    );

    throw new Error(
      `[RERANKER] Copy from APK produced corrupt file (${verify.size ?? 0} bytes). ` +
      'Check EAS build log for [withModelAssets] and [pre-install] output.',
    );
  }

  log.info(
    `_getModelPath() ✅ copy complete — ${(verify.size / 1e6).toFixed(1)} MB in ${elapsed}ms`,
    '| path:', dest,
  );

  return dest;
}

/**
 * _initSession()
 * Loads the ONNX model and logs input/output node names for diagnostics.
 */
async function _initSession() {
  log.info('_initSession() START — MODEL_VERSION:', MODEL_VERSION);
  const startMs   = Date.now();
  const modelPath = await _getModelPath();

  log.info('_initSession() — creating ONNX session from:', modelPath);
  _session = await createModelLoader({ filePath: modelPath });

  // Log node names — if output contains 'hidden_state', model has no head
  const inputNames  = _session.inputNames  ?? [];
  const outputNames = _session.outputNames ?? [];
  log.info('_initSession() INPUT  nodes:', inputNames.join(' | ')  || '(none)');
  log.info('_initSession() OUTPUT nodes:', outputNames.join(' | ') || '(none)');

  // Guard: detect backbone-only export (no classification head)
  const isBackboneOnly = outputNames.some(
    n => n.includes('hidden_state') || n.includes('last_hidden'),
  );
  if (isBackboneOnly) {
    throw new Error(
      '[RERANKER] Model has no classification head — output is hidden states. ' +
      'Re-export with --task text-classification.',
    );
  }

  log.info('_initSession() ✅ session ready in', Date.now() - startMs, 'ms');
}

/**
 * getReranker()
 * Initialises session on first call, returns { rerank }.
 */
export async function getReranker() {
  if (!_sessionInit) {
    log.info('getReranker() — first call, starting init …');
    _sessionInit = _initSession().catch(err => {
      log.error('getReranker() init FAILED:', err.message);
      _sessionInit = null;
      _session     = null;
      throw err;
    });
  } else {
    log.debug('getReranker() — awaiting existing init …');
  }
  await _sessionInit;
  log.debug('getReranker() — returning reranker interface');
  return { rerank };
}

// ─────────────────────────────────────────────────────────────
// TOKENIZE PAIR
// Builds: [CLS] query_tokens [SEP] chunk_tokens [SEP]
// with proper token_type_ids and attention_mask
// ─────────────────────────────────────────────────────────────

async function _tokenizePair(query, chunkText, pairIndex) {
  log.debug(
    `_tokenizePair(pair=${pairIndex})`,
    `query_len=${query.length} chunk_len=${chunkText.length}`,
  );

  const [queryTokens, chunkTokens] = await Promise.all([
    tokenize(query,     { addSpecialTokens: false }),
    tokenize(chunkText, { addSpecialTokens: false }),
  ]);

  // Reserve 3 slots for [CLS], [SEP], [SEP]
  const maxChunkLen    = MAX_LENGTH - queryTokens.length - 3;
  const truncatedChunk = chunkTokens.slice(0, maxChunkLen);

  if (chunkTokens.length > maxChunkLen) {
    log.warn(
      `_tokenizePair(pair=${pairIndex}) chunk truncated:`,
      chunkTokens.length, '→', truncatedChunk.length, 'tokens',
    );
  }

  // Build sequence: [CLS] query [SEP] chunk [SEP]
  const inputIds = [
    CLS_ID,
    ...queryTokens,
    SEP_ID,
    ...truncatedChunk,
    SEP_ID,
  ];

  // token_type_ids: 0 = query segment, 1 = chunk segment
  const tokenTypeIds = [
    0,                                            // CLS
    ...new Array(queryTokens.length).fill(0),     // query tokens
    0,                                            // SEP after query
    ...new Array(truncatedChunk.length).fill(1),  // chunk tokens
    1,                                            // SEP after chunk
  ];

  const attentionMask = new Array(inputIds.length).fill(1);

  log.debug(
    `_tokenizePair(pair=${pairIndex}) seq_len=${inputIds.length}`,
    `(query=${queryTokens.length} + chunk=${truncatedChunk.length} + 3 special)`,
  );

  return { inputIds, tokenTypeIds, attentionMask };
}

// ─────────────────────────────────────────────────────────────
// INT64 BUFFER HELPER
// BigInt64Array.buffer required — Int32Array causes index out-of-bounds
// ─────────────────────────────────────────────────────────────

function toInt64Buffer(arr) {
  const buf = new BigInt64Array(arr.length);
  for (let i = 0; i < arr.length; i++) buf[i] = BigInt(arr[i]);
  return buf.buffer;
}

// ─────────────────────────────────────────────────────────────
// SCORE ONE PAIR
// TinyBERT-L-2-v2 output: "logits" shape [batch, 1]
// logits[0] is the single relevance score — higher = more relevant
// ─────────────────────────────────────────────────────────────

async function _scoreOne(query, chunkText, pairIndex) {
  const startMs = Date.now();

  const { inputIds, tokenTypeIds, attentionMask } =
    await _tokenizePair(query, chunkText, pairIndex);

  const feeds = {
    input_ids:      toInt64Buffer(inputIds),
    attention_mask: toInt64Buffer(attentionMask),
    token_type_ids: toInt64Buffer(tokenTypeIds),
  };

  const results = _session.runAsync
    ? await _session.runAsync(feeds)
    : _session.run(feeds);

  // react-native-nitro-onnxruntime: outputNames is string[], not {name}[]
  const outputKey = _session.outputNames?.[0] ?? 'logits';

  const rawBuffer = results[outputKey];

  if (!rawBuffer) {
    log.error(
      `_scoreOne(pair=${pairIndex}) output key "${outputKey}" missing.`,
      'Available:', Object.keys(results).join(', '),
    );
    throw new Error(
      `[RERANKER] Output key "${outputKey}" not found. Available: ${Object.keys(results).join(', ')}`,
    );
  }

  const logits = new Float32Array(rawBuffer);
  const score  = logits[0]; // shape [batch=1, 1] → single relevance logit

  log.debug(
    `_scoreOne(pair=${pairIndex}) score=${score.toFixed(4)}`,
    `seq_len=${inputIds.length} elapsed=${Date.now() - startMs}ms`,
  );

  return score;
}

// ─────────────────────────────────────────────────────────────
// RERANK — public API
// chunks: array of objects with .content / .text / .parent_content
// returns same array sorted by rerankerScore descending
// ─────────────────────────────────────────────────────────────

async function rerank(query, chunks) {
  if (!_session) {
    log.error('rerank() called but session not initialised');
    throw new Error('[RERANKER] Session not initialised');
  }
  if (!chunks?.length) {
    log.warn('rerank() called with empty chunks — returning []');
    return [];
  }

  log.info('rerank() START', {
    query:        query.slice(0, 100),
    chunkCount:   chunks.length,
    modelVersion: MODEL_VERSION,
  });

  const startMs = Date.now();
  const scored  = [];

  // Score sequentially — avoids OOM on mobile
  for (let i = 0; i < chunks.length; i++) {
    const chunk     = chunks[i];
    const chunkText = chunk.text ?? chunk.content ?? chunk.parent_content ?? '';

    if (!chunkText.trim()) {
      log.warn(`rerank() chunk[${i}] empty — assigning -Infinity`);
      scored.push({ ...chunk, rerankerScore: -Infinity });
      continue;
    }

    try {
      const score = await _scoreOne(query, chunkText, i);
      scored.push({ ...chunk, rerankerScore: score });
    } catch (err) {
      log.error(`rerank() _scoreOne FAILED for chunk[${i}]:`, err.message);
      scored.push({ ...chunk, rerankerScore: -Infinity });
    }
  }

  scored.sort((a, b) => b.rerankerScore - a.rerankerScore);

  const elapsed   = Date.now() - startMs;
  const finite    = scored.map(c => c.rerankerScore).filter(s => isFinite(s));
  const allSame   = finite.length > 1 && finite.every(s => Math.abs(s - finite[0]) < 0.001);

  if (allSame) {
    log.error(
      'rerank() ✗ ALL SCORES IDENTICAL:', finite[0]?.toFixed(4),
      '— corrupt model loaded from cache.',
      'Fix: uninstall app (clears documentDirectory cache) and reinstall fresh APK.',
    );
  } else {
    log.info(
      `rerank() ✅ DONE — ${chunks.length} chunks in ${elapsed}ms`,
      `| top=${finite[0]?.toFixed(4)} bottom=${finite[finite.length - 1]?.toFixed(4)}`,
      `| spread=${(finite[0] - finite[finite.length - 1]).toFixed(4)}`,
    );
  }

  log.debug('rerank() order:',
    scored.map((c, i) =>
      `[${i}] ${c.source || '?'}:p${c.page ?? '?'} → ${c.rerankerScore?.toFixed(4)}`
    ).join(' | '),
  );

  return scored;
}