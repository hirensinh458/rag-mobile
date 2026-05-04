// src/offline/reranker.js
//
// Cross-encoder reranker using ms-marco-MiniLM-L-6-v2.
// Takes a query + array of {chunk} objects, returns them
// re-sorted by relevance score descending.
//
// Input format:  [CLS] query [SEP] chunk [SEP]
// Output:        single logit — higher = more relevant
// Vocab:         same 30522-token BERT vocab as BGE-small ✓
//
// LOGGING ADDED: ONNX model load (cache check, copy, session init time),
// every pair tokenisation, each per-chunk scoring call with logit value
// and timing, final rerank order with scores, and all error paths —
// all tagged [reranker].

import * as FileSystem from 'expo-file-system/legacy';
import { createModelLoader } from 'react-native-nitro-onnxruntime';
import { tokenize } from './tokenizer';
import { createLogger } from '../utils/logger';

// Module-level logger — all lines tagged [reranker]
const log = createLogger('reranker');

// ─────────────────────────────────────────────────────────────
// CONSTANTS  (BERT special token IDs)
// ─────────────────────────────────────────────────────────────

const CLS_ID = 101;
const SEP_ID = 102;
const PAD_ID = 0;
const MAX_LENGTH = 512;   // hard model limit

// ─────────────────────────────────────────────────────────────
// SESSION SINGLETON
// ─────────────────────────────────────────────────────────────

let _session = null;
let _sessionInit = null;

async function _getModelPath() {
  const dest = `${FileSystem.cacheDirectory}reranker.onnx`;
  log.debug('_getModelPath() — checking cache at:', dest);

  const info = await FileSystem.getInfoAsync(dest);
  if (!info.exists) {
    log.info('_getModelPath() — reranker.onnx not in cache, copying from assets …');
    const copyStart = Date.now();
    await FileSystem.copyAsync({
      from: 'asset:///models/reranker.onnx',
      to: dest,
    });
    log.info('_getModelPath() — asset copy complete in', Date.now() - copyStart, 'ms');
  } else {
    log.debug('_getModelPath() — reranker.onnx found in cache');
  }
  return dest;
}

async function _initSession() {
  log.info('_initSession() — initialising ONNX cross-encoder session …');
  const startMs = Date.now();
  const modelPath = await _getModelPath();

  log.info('_initSession() — loading model from:', modelPath);
  _session = await createModelLoader({ filePath: modelPath });

  log.info('_initSession() ✅ Cross-encoder session ready in', Date.now() - startMs, 'ms');
}

export async function getReranker() {
  if (!_sessionInit) {
    log.info('getReranker() — first call, initialising session …');
    _sessionInit = _initSession().catch(err => {
      log.error('getReranker() _initSession() FAILED:', err.message);
      _sessionInit = null;
      _session = null;
      throw err;
    });
  } else {
    log.debug('getReranker() — session init already in progress or done');
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

async function _tokenizePair(query, chunkText) {
  log.debug('_tokenizePair() — tokenising query + chunk pair',
    `| query length: ${query.length} | chunk length: ${chunkText.length}`);

  const [queryTokens, chunkTokens] = await Promise.all([
    tokenize(query, { addSpecialTokens: false }),
    tokenize(chunkText, { addSpecialTokens: false }),
  ]);

  // Reserve 3 slots for [CLS], [SEP], [SEP]
  const maxChunkLen = MAX_LENGTH - queryTokens.length - 3;
  const truncatedChunk = chunkTokens.slice(0, maxChunkLen);

  if (chunkTokens.length > maxChunkLen) {
    log.debug('_tokenizePair() — chunk truncated:',
      chunkTokens.length, '→', truncatedChunk.length, 'tokens');
  }

  // Build sequence
  const inputIds = [
    CLS_ID,
    ...queryTokens,
    SEP_ID,
    ...truncatedChunk,
    SEP_ID,
  ];

  // ───────── ADD TOKEN-ID LOGGING HERE (inside _tokenizePair) ─────────
    console.log('[TOKEN IDS] query text:', query);
    console.log('[TOKEN IDS] chunk text (first 80):', chunkText.slice(0, 80));
    console.log('[TOKEN IDS] truncatedChunk length:', truncatedChunk.length);
    console.log('[TOKEN IDS] truncatedChunk first 20:', truncatedChunk.slice(0, 20));
    console.log('[TOKEN IDS] inputIds length:', inputIds.length);
    console.log('[TOKEN IDS] inputIds first 40:', inputIds.slice(0, 40));
    // ───────── END TOKEN-ID LOGGING ─────────

  // token_type_ids: 0 = query segment, 1 = chunk segment
  const tokenTypeIds = [
    0,                                            // CLS
    ...new Array(queryTokens.length).fill(0),     // query
    0,                                            // SEP after query
    ...new Array(truncatedChunk.length).fill(1),  // chunk
    1,                                            // SEP after chunk
  ];

  const attentionMask = new Array(inputIds.length).fill(1);

  log.debug('_tokenizePair() — sequence length:', inputIds.length,
    `(query=${queryTokens.length} chunk=${truncatedChunk.length})`);

  return { inputIds, tokenTypeIds, attentionMask };
}

// ─────────────────────────────────────────────────────────────
// HELPER
// ─────────────────────────────────────────────────────────────

function toInt64Buffer(arr) {
    const buf = new BigInt64Array(arr.length);
    for (let i = 0; i < arr.length; i++) buf[i] = BigInt(arr[i]);
    return buf.buffer;
}

// ─────────────────────────────────────────────────────────────
// SCORE ONE PAIR
// ─────────────────────────────────────────────────────────────

async function _scoreOne(query, chunkText, chunkIdx) {
  const startMs = Date.now();

  const { inputIds, tokenTypeIds, attentionMask } =
    await _tokenizePair(query, chunkText);

  const feeds = {
    input_ids: toInt64Buffer(inputIds),
    attention_mask: toInt64Buffer(attentionMask),
    token_type_ids: toInt64Buffer(tokenTypeIds),
  };

  const results = _session.runAsync
    ? await _session.runAsync(feeds)
    : _session.run(feeds);

  // DIAGNOSTIC: Log all available outputs
  console.log('[RERANKER DIAG] Available output keys:', Object.keys(results));
  console.log('[RERANKER DIAG] Output names from model:', JSON.stringify(_session.outputNames));

  // Get the output (try multiple possible names)
  const outputKey = _session.outputNames?.[0]?.name
    ?? _session.outputNames?.[0]
    ?? Object.keys(results)[0];

  console.log('[RERANKER DIAG] Using output key:', outputKey);

  const rawBuffer = results[outputKey];
  console.log('[RERANKER DIAG] Raw buffer byteLength:', rawBuffer.byteLength);
  console.log('[RERANKER DIAG] Expected bytes (if single float): 4');
  console.log('[RERANKER DIAG] Expected bytes (if 768-dim): 3072');

  // Try interpreting as different types
  const asFloat32 = new Float32Array(rawBuffer.slice(0, Math.min(rawBuffer.byteLength, 40)));
  console.log('[RERANKER DIAG] As Float32Array (first 10):', Array.from(asFloat32));

  // If buffer is large enough, it might be 64-bit floats
  if (rawBuffer.byteLength >= 8) {
    const asFloat64 = new Float64Array(rawBuffer.slice(0, 8));
    console.log('[RERANKER DIAG] As Float64Array:', Array.from(asFloat64));
  }

  // Check if it's integer type
  const asInt32 = new Int32Array(rawBuffer.slice(0, Math.min(rawBuffer.byteLength, 40)));
  console.log('[RERANKER DIAG] As Int32Array (first 10):', Array.from(asInt32));

  // Original extraction (keep for comparison)
  const logits = new Float32Array(rawBuffer);
  console.log('[RERANKER DIAG] Original logits[0]:', logits[0]);
  console.log('[RERANKER DIAG] Full logits array length:', logits.length);

  // If logits has multiple values, it might be the full embedding
  if (logits.length > 1) {
    console.log('[RERANKER DIAG] ⚠️ Output has', logits.length, 'values — expected 1!');
    console.log('[RERANKER DIAG] This means the ONNX model is exporting embeddings, not scores');
    console.log('[RERANKER DIAG] All values:', Array.from(logits.slice(0, 10)));
  }
  const score = logits[0];

  log.debug(`_scoreOne() chunk[${chunkIdx}] → logit=${score.toFixed(4)} in ${Date.now() - startMs}ms`,
    `| seq_len=${inputIds.length}`);

  // logits[0] is the relevance score — higher = more relevant
  return score;
}

// ─────────────────────────────────────────────────────────────
// RERANK
// chunks: array of objects with at least a `.text` / `.content` field
// returns same array sorted by reranker score descending
// ─────────────────────────────────────────────────────────────

async function rerank(query, chunks) {
  if (!_session) {
    log.error('rerank() called but session not initialised');
    throw new Error('[RERANKER] Session not initialised');
  }
  if (!chunks.length) {
    log.warn('rerank() called with empty chunks array — returning []');
    return chunks;
  }

  log.info('rerank() START — scoring', chunks.length, 'chunks for query:', query.slice(0, 80));
  const startMs = Date.now();

  // Score all pairs — run sequentially to avoid OOM on mobile
  const scored = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const text = chunk.text ?? chunk.content ?? '';
    const score = await _scoreOne(query, text, i);
    scored.push({ ...chunk, rerankerScore: score });
  }

  scored.sort((a, b) => b.rerankerScore - a.rerankerScore);

  const elapsed = Date.now() - startMs;

  log.info(`rerank() ✅ DONE — ${chunks.length} chunks scored in ${elapsed}ms`, {
    topScore: scored[0]?.rerankerScore?.toFixed(4),
    bottomScore: scored[scored.length - 1]?.rerankerScore?.toFixed(4),
    ranking: scored.map((c, i) =>
      `[${i}] ${c.source || '?'}:p${c.page ?? '?'} score=${c.rerankerScore.toFixed(4)}`
    ).join(' | '),
  });

  return scored;
}