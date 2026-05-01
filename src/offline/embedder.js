// src/offline/embedder.js

import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';   // FIX 1
import { Asset } from 'expo-asset';
import { tokenize } from './tokenizer';

// ✅ NEW IMPORT (replaces onnxruntime-react-native)
import { createModelLoader } from 'react-native-nitro-onnxruntime';

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────

const MAX_SEQ_LEN = 128;
const PAD_TOKEN_ID = 0;

// ─────────────────────────────────────────────────────────────
// SESSION SINGLETON
// ─────────────────────────────────────────────────────────────

let _session = null;
let _sessionInit = null;

// ─────────────────────────────────────────────────────────────
// MODEL PATH
// ─────────────────────────────────────────────────────────────

async function _getModelPath() {
  const assetUri = 'asset:///models/bge-small.onnx';
  const dest = `${FileSystem.cacheDirectory}bge-small.onnx`;

  const info = await FileSystem.getInfoAsync(dest);
  if (!info.exists) {
    await FileSystem.copyAsync({
      from: assetUri,
      to: dest,
    });
  }

  return dest;
}

// ─────────────────────────────────────────────────────────────
// INIT SESSION (UPDATED)
// ─────────────────────────────────────────────────────────────

async function _initSession() {
  const modelPath = await _getModelPath();

  // ✅ NEW: nitro loader
  _session = await createModelLoader(modelPath);

  console.log('[Embedder] ✅ ONNX session created via nitro-onnxruntime');
}

// ─────────────────────────────────────────────────────────────
// GET EMBEDDER (FIX 2 retained)
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
// TOKENIZATION WRAPPER
// ─────────────────────────────────────────────────────────────

async function _tokenize(text) {
  const tokenIds = await tokenize(text);

  const inputIds = tokenIds;
  const attentionMask = tokenIds.map(id => id !== PAD_TOKEN_ID ? 1 : 0);
  const tokenTypeIds = new Array(MAX_SEQ_LEN).fill(0);

  return { inputIds, attentionMask, tokenTypeIds };
}

// ─────────────────────────────────────────────────────────────
// EMBEDDING (UPDATED)
// ─────────────────────────────────────────────────────────────

async function embed(text) {
  if (!_session) {
    throw new Error('[EMBEDDER] Session not initialised');
  }

  const { inputIds, attentionMask, tokenTypeIds } = await _tokenize(text);

  // ✅ NEW FEED FORMAT (no Tensor class needed)
  const feeds = {
    input_ids: {
      data: inputIds,
      dims: [1, inputIds.length],
    },
    attention_mask: {
      data: attentionMask,
      dims: [1, attentionMask.length],
    },
    token_type_ids: {
      data: tokenTypeIds,
      dims: [1, tokenTypeIds.length],
    },
  };

  const results = await _session.run(feeds);

  // ─────────────────────────────────────────
  // OUTPUT HANDLING (same as before)
  // ─────────────────────────────────────────

  const hidden =
    results.last_hidden_state?.data ??
    results[Object.keys(results)[0]]?.data;

  if (!hidden || hidden.length < 384) {
    throw new Error(
      `[EMBEDDER] Unexpected model output shape: ${hidden?.length}`
    );
  }

  const clsVec = hidden.slice(0, 384);

  // L2 normalization
  const norm = Math.sqrt(
    clsVec.reduce((sum, v) => sum + v * v, 0)
  );

  return Float32Array.from(clsVec, v => v / (norm || 1));
}

// ─────────────────────────────────────────────────────────────
// COSINE SIM
// ─────────────────────────────────────────────────────────────

export function cosineSim(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}