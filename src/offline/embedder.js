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

async function embed(text) {
  if (!_session) throw new Error('[EMBEDDER] Session not initialised');

  const { inputIds, attentionMask, tokenTypeIds } = await _tokenize(text);

  // FIX 2: feeds must be Record<string, ArrayBuffer>
  // BGE-small expects int64 inputs → BigInt64Array
  const feeds = {
    input_ids: toInt64Buffer(inputIds),
    attention_mask: toInt64Buffer(attentionMask),
    token_type_ids: toInt64Buffer(tokenTypeIds),
  };

  // Use runAsync if available, fall back to run
  const results = _session.runAsync
    ? await _session.runAsync(feeds)
    : _session.run(feeds);

  // ─────────────────────────────────────────
  // OUTPUT: results is Record<string, ArrayBuffer>
  // Convert the first output buffer to Float32Array
  // ─────────────────────────────────────────

  // Get the string key safely, regardless of whether outputNames
  // returns strings or Tensor descriptor objects
  const outputKey = _session.outputNames?.[0]?.name   // { name: "last_hidden_state", ... }
    ?? _session.outputNames?.[0]          // already a string fallback
    ?? 'last_hidden_state';               // hardcoded fallback

  const rawBuffer = results[outputKey];

  if (!rawBuffer) {
    throw new Error(
      `[EMBEDDER] No output for key "${outputKey}". ` +
      `Available keys: ${Object.keys(results).join(', ')}`
    );
  }

  const hidden = new Float32Array(rawBuffer);

  if (hidden.length < 384) {
    throw new Error(`[EMBEDDER] Unexpected output shape: ${hidden.length}`);
  }

  // CLS token = first 384 floats
  const clsVec = hidden.slice(0, 384);

  // L2 normalise
  const norm = Math.sqrt(clsVec.reduce((s, v) => s + v * v, 0));
  return Float32Array.from(clsVec, v => v / (norm || 1));
}

// ─────────────────────────────────────────────────────────────
// COSINE SIM
// ─────────────────────────────────────────────────────────────

export function cosineSim(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}