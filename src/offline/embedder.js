// src/offline/embedder.js

import * as FileSystem from 'expo-file-system/legacy';
import { Asset } from 'expo-asset';
import { tokenize } from './tokenizer';
import { createModelLoader } from 'react-native-nitro-onnxruntime';

const MAX_SEQ_LEN = 128;
const PAD_TOKEN_ID = 0;

let _session = null;
let _sessionInit = null;

// ─────────────────────────────────────────────────────────────
// MODEL PATH
// ─────────────────────────────────────────────────────────────

async function _getModelPath() {
  const dest = `${FileSystem.cacheDirectory}bge-small.onnx`;
  const info = await FileSystem.getInfoAsync(dest);
  if (!info.exists) {
    await FileSystem.copyAsync({
      from: 'asset:///models/bge-small.onnx',
      to: dest,
    });
  }
  return dest;
}

// ─────────────────────────────────────────────────────────────
// INIT SESSION
// ─────────────────────────────────────────────────────────────

async function _initSession() {
  const modelPath = await _getModelPath();
  _session = await createModelLoader({ filePath: modelPath });

  // Extract name strings for easy logging
  const inputNames = _session.inputNames.map(t => t.name ?? t);
  const outputNames = _session.outputNames.map(t => t.name ?? t);

  console.log('[Embedder] ✅ Session ready');
  console.log('[Embedder] Inputs:', inputNames);
  console.log('[Embedder] Outputs:', outputNames);
}

// ─────────────────────────────────────────────────────────────
// GET EMBEDDER
// ─────────────────────────────────────────────────────────────

export async function getEmbedder() {
  if (!_sessionInit) {
    _sessionInit = _initSession().catch(err => {
      _sessionInit = null;
      _session = null;
      throw err;
    });
  }
  await _sessionInit;
  return { embed };
}

// ─────────────────────────────────────────────────────────────
// TOKENIZATION
// ─────────────────────────────────────────────────────────────

async function _tokenize(text) {
  const tokenIds = await tokenize(text);
  const inputIds = tokenIds;
  const attentionMask = tokenIds.map(id => id !== PAD_TOKEN_ID ? 1 : 0);
  const tokenTypeIds = new Array(inputIds.length).fill(0);
  return { inputIds, attentionMask, tokenTypeIds };
}

// ─────────────────────────────────────────────────────────────
// HELPER: number[] → BigInt64Array buffer (ONNX int64)
// ─────────────────────────────────────────────────────────────

function toInt64Buffer(arr) {
  const buf = new BigInt64Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    buf[i] = BigInt(arr[i]);
  }
  return buf.buffer;
}

// ─────────────────────────────────────────────────────────────
// EMBED
// ─────────────────────────────────────────────────────────────

// src/offline/embedder.js

async function embed(text) {
  if (!_session) throw new Error('[EMBEDDER] Session not initialised');

  const { inputIds, attentionMask, tokenTypeIds } = await _tokenize(text);

  const feeds = {
    input_ids: toInt64Buffer(inputIds),
    attention_mask: toInt64Buffer(attentionMask),
    token_type_ids: toInt64Buffer(tokenTypeIds),
  };

  const results = _session.runAsync
    ? await _session.runAsync(feeds)
    : _session.run(feeds);

  const outputKey = _session.outputNames?.[0]?.name
    ?? _session.outputNames?.[0]
    ?? 'last_hidden_state';

  const rawBuffer = results[outputKey];
  if (!rawBuffer) {
    throw new Error(
      `[EMBEDDER] No output for key "${outputKey}". ` +
      `Available: ${Object.keys(results).join(', ')}`
    );
  }

  // src/offline/embedder.js — replace everything after rawBuffer check

  const hidden = new Float32Array(rawBuffer);
  const DIM = 384;

  let embedding;

  if (hidden.length === DIM) {
    // Model already outputs a pooled [384] vector — use it directly
    console.log('[Embedder] Model has built-in pooling, skipping mean pool');
    embedding = hidden;
  } else {
    // Full hidden state [seq_len, 384] — do mean pooling ourselves
    const seqLen = inputIds.length;

    if (hidden.length < seqLen * DIM) {
      throw new Error(`[EMBEDDER] Output shape mismatch: got ${hidden.length}, expected ${seqLen * DIM}`);
    }

    const meanVec = new Float32Array(DIM);
    let maskedCount = 0;

    for (let pos = 0; pos < seqLen; pos++) {
      const mask = attentionMask[pos];
      if (mask === 0) continue;
      maskedCount++;
      for (let dim = 0; dim < DIM; dim++) {
        meanVec[dim] += hidden[pos * DIM + dim];
      }
    }
    for (let dim = 0; dim < DIM; dim++) {
      meanVec[dim] /= maskedCount || 1;
    }

    embedding = meanVec;
  }

  // ── L2 NORMALISE ───────────────────────────────────────────
  const norm = Math.sqrt(embedding.reduce((s, v) => s + v * v, 0));
  return Float32Array.from(embedding, v => v / (norm || 1));
}

// ─────────────────────────────────────────────────────────────
// COSINE SIM
// ─────────────────────────────────────────────────────────────

export function cosineSim(a, b) {
  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  magA = Math.sqrt(magA);
  magB = Math.sqrt(magB);

  return dot / (magA * magB);
}