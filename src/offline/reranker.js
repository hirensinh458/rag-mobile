// src/offline/reranker.js — FIXED (all 4 bugs resolved)
//
// ══════════════════════════════════════════════════════════════════════════════
// ROOT CAUSE ANALYSIS — why you always got -4.875
// ══════════════════════════════════════════════════════════════════════════════
//
// BUG 1 — Wrong model: Official HF ONNX has NO classification head.
//   cross-encoder/ms-marco-MiniLM-L-6-v2 (official HF export) outputs:
//     "last_hidden_state"  shape=[batch, seq_len, 384]
//   Your _scoreOne() did:  out[0][0][0]
//   That reads hidden_state[batch=0][token_pos=0][dim=0] — the CLS token's
//   first hidden dimension. It is always the same bias value (-4.875) because
//   it never passes through a classification head. The model IS the backbone
//   only; the Linear(384→1) scoring layer was never exported.
//
// BUG 2 — Wrong index for binary-classification models (Xenova).
//   Xenova/ms-marco-MiniLM-L-6-v2 outputs:
//     "logits"  shape=[batch, 2]   → (irrelevant_score, relevant_score)
//   Your code read logits[0] = P(irrelevant), always a high negative bias (-8.090).
//   You needed logits[1] = P(relevant), OR score = logits[1] - logits[0].
//
// BUG 3 — Stale model cache never busted.
//   _getModelPath() only copies from APK assets when the cached file does
//   NOT exist. Once any model is cached, all future APK updates are ignored.
//   Fix: embed MODEL_VERSION in the cached filename. New version → different
//   filename → old file not found → fresh copy forced automatically.
//
// BUG 4 — Session singleton survives Metro hot reload.
//   _sessionInit is module-level. Metro's fast-refresh keeps the old promise
//   alive even after you change the ONNX file. Only a full "Reload" clears it.
//   Fix: MODEL_VERSION change forces a new filename → new session on cold start.
//
// ══════════════════════════════════════════════════════════════════════════════
// WHICH MODEL TO USE
// ══════════════════════════════════════════════════════════════════════════════
//
//  RECOMMENDED — svilupp FP32 ONNX, output shape [batch, 1], single logit.
//    This is the only community ONNX confirmed to have a full classification
//    head AND unambiguous single-logit output.  Set MODEL_OUTPUT_MODE='single'.
//
//  ALTERNATIVE — Xenova/ms-marco-MiniLM-L-6-v2, output shape [batch, 2].
//    Works if you set MODEL_OUTPUT_MODE='binary' (reads logits[1]-logits[0]).
//
//  DO NOT USE — Official HF ONNX. Backbone only, no scoring head.
//
// ══════════════════════════════════════════════════════════════════════════════
// HOW TO EXPORT AND VERIFY YOUR OWN ONNX (run on dev machine, not mobile)
// ══════════════════════════════════════════════════════════════════════════════
//
//   pip install transformers torch optimum[exporters] onnxruntime
//
//   python3 -c "
//   from optimum.exporters.onnx import main_export
//   main_export(
//     model_name_or_path='cross-encoder/ms-marco-MiniLM-L-6-v2',
//     output='./reranker_export',
//     task='text-classification',
//     opset=14,
//   )"
//
//   # VERIFY — scores MUST differ between relevant and irrelevant pairs:
//   python3 -c "
//   import onnxruntime as ort, numpy as np
//   s = ort.InferenceSession('./reranker_export/model.onnx')
//   print('Inputs: ', [(i.name, i.shape) for i in s.get_inputs()])
//   print('Outputs:', [(o.name, o.shape) for o in s.get_outputs()])
//   def score(q, c):
//     ids  = np.array([[101]+q+[102]+c+[102]], dtype=np.int64)
//     mask = np.ones_like(ids)
//     tt   = np.array([[0]*(len(q)+2)+[1]*(len(c)+1)], dtype=np.int64)
//     out  = s.run(None, {'input_ids':ids,'attention_mask':mask,'token_type_ids':tt})
//     return float(out[0].flatten()[0])
//   rel = score([2054,2003,1996,3007,1997,2605],[3000,2003,1996,3007,1997,2605,1012])
//   irr = score([2054,2003,1996,3007,1997,2605],[1996,3899,2003,2058,1996,5415,1012])
//   print(f'Relevant:{rel:.4f}  Irrelevant:{irr:.4f}')
//   assert rel > irr, 'FAIL — model has no classification head!'
//   print('PASS: model is correct')
//   "
//
//   cp ./reranker_export/model.onnx <project>/assets/models/reranker.onnx
//   # Then bump MODEL_VERSION below to force cache bust on next EAS build.
//
// ══════════════════════════════════════════════════════════════════════════════

import * as FileSystem from 'expo-file-system/legacy';
import { createModelLoader } from 'react-native-nitro-onnxruntime';
import { tokenize } from './tokenizer';
import { createLogger } from '../utils/logger';
import { Asset } from 'expo-asset';

// Module-level logger — all lines tagged [reranker]
const log = createLogger('reranker');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION
// Bump MODEL_VERSION whenever you update assets/models/reranker.onnx.
// This is the ONLY reliable way to force the on-device cache to bust.
// ─────────────────────────────────────────────────────────────────────────────

const MODEL_VERSION = 'tinybert-l2-v2'; // ← change to 'v2', 'v3' … when you update the file

// TinyBERT-L-2-v2 (BertForSequenceClassification, num_labels=1):
//   output node: "logits"  shape=[batch_size, 1]
//   → single relevance logit, higher = more relevant
const MODEL_OUTPUT_MODE = 'single';

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const CLS_ID     = 101;
const SEP_ID     = 102;
const MAX_LENGTH = 512;

// ─────────────────────────────────────────────────────────────────────────────
// SESSION SINGLETON
// ─────────────────────────────────────────────────────────────────────────────

let _session     = null;
let _sessionInit = null;

/**
 * _getModelPath()
 *
 * FIX for BUG 3 (stale cache) + BUG 4 (hot-reload singleton):
 *   Caches the ONNX file as  reranker_<MODEL_VERSION>.onnx
 *   When MODEL_VERSION changes, the old filename no longer exists,
 *   so the new model is copied from APK assets automatically.
 *   Old versioned files are deleted to reclaim disk space.
 */
async function _getModelPath() {
  // Versioned cache path — changing MODEL_VERSION automatically busts the cache
  // and forces a fresh extraction from the APK bundle on next cold start.
  const dest = `${FileSystem.cacheDirectory}reranker_${MODEL_VERSION}.onnx`;
 
  log.info('_getModelPath() — MODEL_VERSION:', MODEL_VERSION);
  log.debug('_getModelPath() — expected cache path:', dest);
 
  // ── Check if this version is already extracted and valid ─────────────────
  const info = await FileSystem.getInfoAsync(dest);
 
  if (info.exists && info.size > 15_000_000) {
    // File exists AND is a plausible size (>15 MB) — use it
    log.info(
      `_getModelPath() ✅ valid cached model found — ${(info.size / 1e6).toFixed(1)} MB`,
      '| path:', dest,
    );
    return dest;
  }
 
  if (info.exists && info.size <= 15_000_000) {
    // File exists but is suspiciously small — previous extraction was corrupt
    log.warn(
      `_getModelPath() ⚠ cached file is too small (${info.size} bytes) — deleting corrupt cache`,
    );
    await FileSystem.deleteAsync(dest, { idempotent: true });
  }
 
  // ── Delete ALL old versioned files to free disk space ────────────────────
  log.info('_getModelPath() — purging old versioned caches …');
  try {
    const cacheDir = FileSystem.cacheDirectory;
    const allFiles = await FileSystem.readDirectoryAsync(cacheDir);
    const oldFiles = allFiles.filter(
      f => f.startsWith('reranker_') && f.endsWith('.onnx'),
    );
    for (const old of oldFiles) {
      log.info('_getModelPath() 🗑 deleting stale cache:', old);
      await FileSystem.deleteAsync(cacheDir + old, { idempotent: true });
    }
    if (oldFiles.length === 0) log.debug('_getModelPath() — no old caches found');
  } catch (cleanErr) {
    // Non-fatal — proceed with extraction even if cleanup fails
    log.warn('_getModelPath() cleanup error (non-fatal):', cleanErr.message);
  }
 
  // ── Extract from APK bundle using expo-asset ──────────────────────────────
  //
  // This is the correct way to access files placed in assets/models/ via the
  // pre-install script. FileSystem.copyAsync('asset:///...') is unreliable on
  // Android — it silently produces 0-byte files on many devices.
  // Asset.fromModule().downloadAsync() is the Expo-supported extraction path.
  //
  log.info('_getModelPath() — extracting reranker.onnx from APK bundle via expo-asset …');
  const extractStart = Date.now();
 
  // require() path must be a static string — Metro resolves it at bundle time.
  // The pre-install script places the file at assets/models/reranker.onnx
  // which maps to this require() path from src/offline/reranker.js:
  const asset = Asset.fromModule(
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('../../assets/models/reranker.onnx'),
  );
 
  log.debug('_getModelPath() — asset.uri:', asset.uri,
    '| asset.localUri:', asset.localUri ?? '(not yet downloaded)');
 
  await asset.downloadAsync(); // extracts the bundled asset to a local file:// URI
 
  if (!asset.localUri) {
    log.error('_getModelPath() ✗ asset.downloadAsync() succeeded but localUri is null');
    throw new Error('[RERANKER] expo-asset extraction returned null localUri');
  }
 
  log.info('_getModelPath() — expo-asset extracted to:', asset.localUri,
    `in ${Date.now() - extractStart}ms`);
 
  // Copy from expo-asset's internal cache to our versioned cache path so we
  // control the filename (and can bust it with MODEL_VERSION).
  log.debug('_getModelPath() — copying to versioned cache:', dest);
  await FileSystem.copyAsync({ from: asset.localUri, to: dest });
 
  // Verify the copy is a real file and large enough
  const verify = await FileSystem.getInfoAsync(dest);
  if (!verify.exists || verify.size < 15_000_000) {
    log.error(
      '_getModelPath() ✗ post-copy verification FAILED —',
      `exists=${verify.exists} size=${verify.size ?? 0} bytes`,
      '\n  The model file may be corrupt or the pre-install script may have failed.',
      '\n  Check that pre-install.sh ran successfully before this EAS build.',
    );
    throw new Error(
      `[RERANKER] Model file too small after extraction (${verify.size ?? 0} bytes). ` +
      'Check pre-install.sh output in the EAS build log.'
    );
  }
 
  log.info(
    `_getModelPath() ✅ model ready — ${(verify.size / 1e6).toFixed(1)} MB | path:`, dest,
  );
  return dest;
}

/**
 * _initSession()
 *
 * Loads the ONNX model and immediately logs input/output node names and shapes
 * so you can verify at runtime that the classification head is present.
 * Throws a descriptive error if a backbone-only model is detected.
 */
async function _initSession() {
  log.info('_initSession() START — MODEL_VERSION:', MODEL_VERSION,
    '| MODEL_OUTPUT_MODE:', MODEL_OUTPUT_MODE);

  const startMs   = Date.now();
  const modelPath = await _getModelPath();

  log.info('_initSession() — creating ONNX session from:', modelPath);
  _session = await createModelLoader({ filePath: modelPath });

  // ── Log all node metadata — most important diagnostic step ───────────────
  const inputNames  = _session.inputNames  ?? [];
  const outputNames = _session.outputNames ?? [];

  log.info('_initSession() ONNX INPUT NODES :', inputNames.length
    ? inputNames.join(' | ')
    : '(none returned by runtime — may still work)');
  log.info('_initSession() ONNX OUTPUT NODES:', outputNames.length
    ? outputNames.join(' | ')
    : '(none returned by runtime)');

  if (_session.outputShapes) {
    log.info('_initSession() ONNX OUTPUT SHAPES:', JSON.stringify(_session.outputShapes));
  }

  // ── BUG 1 guard: detect backbone-only model and refuse to proceed ────────
  const hasHiddenState = outputNames.some(
    n => n.includes('hidden_state') || n.includes('last_hidden')
  );
  if (hasHiddenState || MODEL_OUTPUT_MODE === 'hidden') {
    const msg =
      '[RERANKER] Model has no classification head (output is hidden states, not logits). ' +
      'This model will always produce the same score for every input. ' +
      'Re-export with --task text-classification. ' +
      'See the instructions at the top of reranker.js.';
    log.error('_initSession() ✗ BACKBONE-ONLY MODEL DETECTED —', msg);
    throw new Error(msg);
  }

  log.info('_initSession() ✅ session ready in', Date.now() - startMs, 'ms');
}

/**
 * getReranker()
 * Initialises the session on first call, returns { rerank } once ready.
 */
export async function getReranker() {
  if (!_sessionInit) {
    log.info('getReranker() — first call, starting session init …');
    _sessionInit = _initSession().catch(err => {
      log.error('getReranker() init FAILED:', err.message);
      // Allow retry after failure (e.g. after user fixes the asset)
      _sessionInit = null;
      _session     = null;
      throw err;
    });
  } else {
    log.debug('getReranker() — session init already in progress or complete');
  }
  await _sessionInit;
  log.debug('getReranker() — returning reranker interface');
  return { rerank };
}

// ─────────────────────────────────────────────────────────────────────────────
// TOKENIZE PAIR
// Builds [CLS] query_tokens [SEP] chunk_tokens [SEP] with type IDs + mask
// ─────────────────────────────────────────────────────────────────────────────

async function _tokenizePair(query, chunkText, pairIndex) {
  log.debug(
    `_tokenizePair(pair=${pairIndex}) — query len=${query.length} chunk len=${chunkText.length}`,
  );

  const [queryTokens, chunkTokens] = await Promise.all([
    tokenize(query,     { addSpecialTokens: false }),
    tokenize(chunkText, { addSpecialTokens: false }),
  ]);

  log.debug(
    `_tokenizePair(pair=${pairIndex}) raw token counts —`,
    `query=${queryTokens.length} chunk=${chunkTokens.length}`,
  );

  // Truncate chunk so total fits in MAX_LENGTH (512)
  const maxChunkLen    = MAX_LENGTH - queryTokens.length - 3; // 3 = CLS + SEP + SEP
  const truncatedChunk = chunkTokens.slice(0, maxChunkLen);

  if (chunkTokens.length > maxChunkLen) {
    log.warn(
      `_tokenizePair(pair=${pairIndex}) chunk truncated`,
      `${chunkTokens.length} → ${truncatedChunk.length} tokens (MAX_LENGTH=512)`,
    );
  }

  // Sequence: [CLS] query [SEP] chunk [SEP]
  const inputIds = [
    CLS_ID,
    ...queryTokens,
    SEP_ID,
    ...truncatedChunk,
    SEP_ID,
  ];

  // token_type_ids — segment A = 0, segment B = 1
  const tokenTypeIds = [
    0,
    ...new Array(queryTokens.length).fill(0),
    0,                                             // SEP after query = still segment A
    ...new Array(truncatedChunk.length).fill(1),
    1,                                             // SEP after chunk = segment B
  ];

  const attentionMask = new Array(inputIds.length).fill(1);

  log.debug(
    `_tokenizePair(pair=${pairIndex}) final seq_len=${inputIds.length}`,
    `(query=${queryTokens.length} + chunk=${truncatedChunk.length} + 3 special tokens)`,
  );

  return { inputIds, tokenTypeIds, attentionMask };
}

// ─────────────────────────────────────────────────────────────────────────────
// INT64 BUFFER HELPER
// react-native-nitro-onnxruntime needs BigInt64Array.buffer for int64 inputs.
// Int32Array causes "index out of bounds" — this was your attempt 5 failure.
// ─────────────────────────────────────────────────────────────────────────────

function toInt64Buffer(arr) {
  const buf = new BigInt64Array(arr.length);
  for (let i = 0; i < arr.length; i++) buf[i] = BigInt(arr[i]);
  return buf.buffer;
}

// ─────────────────────────────────────────────────────────────────────────────
// SCORE ONE PAIR
//
// FIX for BUG 1 + BUG 2: reads the correct logit based on MODEL_OUTPUT_MODE.
//
//   'single' (svilupp, recommended):
//     logits shape [1] — score = logits[0]
//
//   'binary' (Xenova):
//     logits shape [2] = [P(irrelevant), P(relevant)]
//     score = logits[1] - logits[0]  ← log-odds, monotonically correct
//     NOT logits[0] which was always reading the "irrelevant" bias (-8.090)
// ─────────────────────────────────────────────────────────────────────────────

async function _scoreOne(query, chunkText, pairIndex) {
  const startMs = Date.now();

  const { inputIds, tokenTypeIds, attentionMask } =
    await _tokenizePair(query, chunkText, pairIndex);

  const feeds = {
    input_ids:      toInt64Buffer(inputIds),
    attention_mask: toInt64Buffer(attentionMask),
    token_type_ids: toInt64Buffer(tokenTypeIds),
  };

  log.debug(`_scoreOne(pair=${pairIndex}) running inference — seq_len=${inputIds.length}`);

  const results = _session.runAsync
    ? await _session.runAsync(feeds)
    : _session.run(feeds);

  // Resolve output key from session metadata
  const outputNames = _session.outputNames ?? [];
  const outputKey   = outputNames[0] ?? 'logits';

  const rawBuffer = results[outputKey];
  if (!rawBuffer) {
    const available = Object.keys(results).join(', ');
    log.error(
      `_scoreOne(pair=${pairIndex}) output key "${outputKey}" not found.`,
      'Available:', available,
      '| Try setting outputKey to one of these in the code.',
    );
    throw new Error(
      `[RERANKER] Output key "${outputKey}" not in results. Available: ${available}`
    );
  }

  const logits = new Float32Array(rawBuffer);

  log.debug(
    `_scoreOne(pair=${pairIndex}) raw logits [${logits.length}]:`,
    Array.from(logits).map(v => v.toFixed(4)).join(', '),
  );

  // ── FIX BUG 2: read correct index ────────────────────────────────────────
  let score;

  if (MODEL_OUTPUT_MODE === 'single') {
    // svilupp FP32, TinyBERT exported with optimum: logits.length === 1
    if (logits.length !== 1) {
      log.warn(
        `_scoreOne(pair=${pairIndex}) MODEL_OUTPUT_MODE='single' but logits.length=${logits.length}.`,
        'If using Xenova, set MODEL_OUTPUT_MODE="binary".',
      );
    }
    score = logits[0];

  } else if (MODEL_OUTPUT_MODE === 'binary') {
    // Xenova: logits = [P(irrelevant), P(relevant)]
    if (logits.length < 2) {
      log.error(
        `_scoreOne(pair=${pairIndex}) MODEL_OUTPUT_MODE='binary' but logits.length=${logits.length}.`,
        'If using a single-logit model, set MODEL_OUTPUT_MODE="single".',
      );
      score = logits[0]; // best-effort fallback
    } else {
      // Log-odds: higher P(relevant) relative to P(irrelevant) → higher score
      score = logits[1] - logits[0];
      log.debug(
        `_scoreOne(pair=${pairIndex}) binary mode:`,
        `P(irrel)=${logits[0].toFixed(4)}`,
        `P(rel)=${logits[1].toFixed(4)}`,
        `→ log-odds=${score.toFixed(4)}`,
      );
    }

  } else {
    // MODEL_OUTPUT_MODE === 'hidden' is caught in _initSession, but just in case:
    throw new Error(
      `[RERANKER] Invalid MODEL_OUTPUT_MODE="${MODEL_OUTPUT_MODE}". ` +
      'Use "single" or "binary". See reranker.js header.'
    );
  }

  log.debug(
    `_scoreOne(pair=${pairIndex}) ✅ score=${score.toFixed(4)} in ${Date.now() - startMs}ms`,
    `| seq_len=${inputIds.length} | mode=${MODEL_OUTPUT_MODE}`,
  );

  return score;
}

// ─────────────────────────────────────────────────────────────────────────────
// RERANK — public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Score and re-rank chunks by cross-encoder relevance.
 *
 * @param {string}   query   — raw user question
 * @param {object[]} chunks  — must each have .content, .text, or .parent_content
 * @returns {object[]}       — same objects sorted by .rerankerScore DESC
 */
async function rerank(query, chunks) {
  if (!_session) {
    log.error('rerank() called but session not initialised — call getReranker() first');
    throw new Error('[RERANKER] Session not initialised');
  }
  if (!chunks?.length) {
    log.warn('rerank() called with empty chunks — returning []');
    return [];
  }

  log.info('rerank() START', {
    query:        query.slice(0, 100),
    chunkCount:   chunks.length,
    outputMode:   MODEL_OUTPUT_MODE,
    modelVersion: MODEL_VERSION,
  });

  const startMs = Date.now();
  const scored  = [];

  // Run sequentially — avoids OOM on mobile (no GPU parallelism available)
  for (let i = 0; i < chunks.length; i++) {
    const chunk     = chunks[i];
    const chunkText = chunk.text ?? chunk.content ?? chunk.parent_content ?? '';

    if (!chunkText.trim()) {
      log.warn(`rerank() chunk[${i}] is empty — assigning -Infinity`);
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

  // Sort: highest relevance first
  scored.sort((a, b) => b.rerankerScore - a.rerankerScore);

  const elapsed   = Date.now() - startMs;
  const allScores = scored.map(c => c.rerankerScore).filter(s => isFinite(s));

  // ── Critical self-check: identical scores = BUG 1 or BUG 2 still present ─
  const allSame = allScores.length > 1 &&
    allScores.every(s => Math.abs(s - allScores[0]) < 0.001);

  if (allSame) {
    log.error(
      'rerank() ✗ ALL SCORES ARE IDENTICAL:', allScores[0]?.toFixed(4),
      '\n  DIAGNOSIS:',
      '\n    - If score ≈ -4.875 → BUG 1: model has no head (official HF export). Re-export.',
      '\n    - If score ≈ -8.090 → BUG 2: Xenova binary model, reading wrong logit.',
      '\n      Fix: set MODEL_OUTPUT_MODE = "binary" in reranker.js',
      '\n    - If score is some other constant → BUG 3: stale cached model.',
      '\n      Fix: bump MODEL_VERSION in reranker.js and rebuild the APK.',
      '\n  Run the Python verification script in the file header to confirm your model.',
    );
  } else if (allScores.length > 1) {
    log.info(
      `rerank() ✅ DONE — ${chunks.length} chunks in ${elapsed}ms`,
      `| top=${allScores[0]?.toFixed(4)}`,
      `| bottom=${allScores[allScores.length - 1]?.toFixed(4)}`,
      `| spread=${(allScores[0] - allScores[allScores.length - 1]).toFixed(4)}`,
    );
  }

  log.debug(
    'rerank() final order:',
    scored.map((c, i) =>
      `[${i}] ${c.source || '?'}:p${c.page ?? '?'} → ${c.rerankerScore?.toFixed(4)}`
    ).join(' | '),
  );

  return scored;
}