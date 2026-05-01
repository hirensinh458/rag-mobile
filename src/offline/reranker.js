// src/offline/reranker.js
//
// Cross-encoder reranker using ms-marco-MiniLM-L-6-v2.
// Takes a query + array of {chunk} objects, returns them
// re-sorted by relevance score descending.
//
// Input format:  [CLS] query [SEP] chunk [SEP]
// Output:        single logit — higher = more relevant
// Vocab:         same 30522-token BERT vocab as BGE-small ✓

import * as FileSystem from 'expo-file-system/legacy';
import { createModelLoader } from 'react-native-nitro-onnxruntime';
import { tokenize } from './tokenizer';

// ─────────────────────────────────────────────────────────────
// CONSTANTS  (BERT special token IDs)
// ─────────────────────────────────────────────────────────────

const CLS_ID     = 101;
const SEP_ID     = 102;
const PAD_ID     = 0;
const MAX_LENGTH = 512;   // hard model limit

// ─────────────────────────────────────────────────────────────
// SESSION SINGLETON
// ─────────────────────────────────────────────────────────────

let _session     = null;
let _sessionInit = null;

async function _getModelPath() {
  const dest = `${FileSystem.cacheDirectory}reranker.onnx`;
  const info = await FileSystem.getInfoAsync(dest);
  if (!info.exists) {
    await FileSystem.copyAsync({
      from: 'asset:///models/reranker.onnx',
      to: dest,
    });
  }
  return dest;
}

async function _initSession() {
  const modelPath = await _getModelPath();
  _session = await createModelLoader({ filePath: modelPath });
  console.log('[Reranker] ✅ Cross-encoder session ready');
}

export async function getReranker() {
  if (!_sessionInit) {
    _sessionInit = _initSession().catch(err => {
      _sessionInit = null;
      _session     = null;
      throw err;
    });
  }
  await _sessionInit;
  return { rerank };
}

// ─────────────────────────────────────────────────────────────
// TOKENIZE PAIR
// Builds: [CLS] query_tokens [SEP] chunk_tokens [SEP]
// with proper token_type_ids and attention_mask
// ─────────────────────────────────────────────────────────────

async function _tokenizePair(query, chunkText) {
  const [queryTokens, chunkTokens] = await Promise.all([
    tokenize(query,     { addSpecialTokens: false }),
    tokenize(chunkText, { addSpecialTokens: false }),
  ]);

  // Reserve 3 slots for [CLS], [SEP], [SEP]
  const maxChunkLen = MAX_LENGTH - queryTokens.length - 3;
  const truncatedChunk = chunkTokens.slice(0, maxChunkLen);

  // Build sequence
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
    ...new Array(queryTokens.length).fill(0),     // query
    0,                                            // SEP after query
    ...new Array(truncatedChunk.length).fill(1),  // chunk
    1,                                            // SEP after chunk
  ];

  const attentionMask = new Array(inputIds.length).fill(1);

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

async function _scoreOne(query, chunkText) {
  const { inputIds, tokenTypeIds, attentionMask } =
    await _tokenizePair(query, chunkText);

  const feeds = {
    input_ids:      toInt64Buffer(inputIds),
    attention_mask: toInt64Buffer(attentionMask),
    token_type_ids: toInt64Buffer(tokenTypeIds),
  };

  const results = _session.runAsync
    ? await _session.runAsync(feeds)
    : _session.run(feeds);

  // ms-marco model outputs a single logit (shape [1,1] or [1])
  const outputKey = _session.outputNames?.[0]?.name
                 ?? _session.outputNames?.[0]
                 ?? 'logits';

  const rawBuffer = results[outputKey];
  const logits    = new Float32Array(rawBuffer);

  // logits[0] is the relevance score — higher = more relevant
  return logits[0];
}

// ─────────────────────────────────────────────────────────────
// RERANK
// chunks: array of objects with at least a `.text` field
// returns same array sorted by reranker score descending
// ─────────────────────────────────────────────────────────────

async function rerank(query, chunks) {
  if (!_session)  throw new Error('[RERANKER] Session not initialised');
  if (!chunks.length) return chunks;

  const startMs = Date.now();

  // Score all pairs — run sequentially to avoid OOM on mobile
  const scored = [];
  for (const chunk of chunks) {
    const score = await _scoreOne(query, chunk.text ?? chunk.content ?? '');
    scored.push({ ...chunk, rerankerScore: score });
  }

  scored.sort((a, b) => b.rerankerScore - a.rerankerScore);

  console.log(
    `[Reranker] Reranked ${chunks.length} chunks in ${Date.now() - startMs}ms | ` +
    `top score: ${scored[0]?.rerankerScore?.toFixed(3)}`
  );

  return scored;
}