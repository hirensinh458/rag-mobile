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

// src/offline/embedder.js — simplified embed() for the new pooled model
// ... (keep all imports, model loading, tokenizer import, etc. unchanged) ...

/**
 * Embed a query text into a 384-dim Float32Array (already L2-normalised).
 * The new model outputs a single [1, 384] vector — no further processing needed.
 */
async function embed(text) {
  if (!_session) throw new Error('[EMBEDDER] Session not initialised');

  // Apply the BGE query prefix (same as the Python backend)
  text = `Represent this sentence for searching relevant passages: ${text}`;

  const { inputIds, attentionMask, tokenTypeIds } = await _tokenize(text);

  // Ensure exactly 128 tokens (the model expects fixed‑size input)
  const clampedIds   = inputIds.slice(0, MAX_SEQ_LEN);
  const clampedMask  = attentionMask.slice(0, MAX_SEQ_LEN);
  const clampedToken = tokenTypeIds.slice(0, MAX_SEQ_LEN);

  const feeds = {
    input_ids:       toInt64Buffer(clampedIds),
    attention_mask:  toInt64Buffer(clampedMask),
    token_type_ids:  toInt64Buffer(clampedToken),
  };

  const results = _session.runAsync
    ? await _session.runAsync(feeds)
    : _session.run(feeds);

  // The output key is "embedding" — a Float32Array of length 384
  const outputKey = _session.outputNames?.[0]?.name ?? 'embedding';
  const embedding = new Float32Array(results[outputKey]);

  // Verification log (optional)
  const norm = Math.sqrt(embedding.reduce((s, v) => s + v * v, 0));
  console.log('[Embedder] Output norm:', norm.toFixed(4)); // should be ~1.0000

  return embedding;
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