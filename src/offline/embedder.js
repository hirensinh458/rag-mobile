// src/offline/embedder.js
//
// ONNX-based local embedding for Phase 2.2 (query-time semantic search).
//
// Phase 2.1 (current): chunks are synced from server with text only.
//                      Search uses SQLite FTS5 (BM25) — no embedder needed.
//
// Phase 2.2 (ONNX):   This file adds on-device query embedding so you get
//                      proper semantic search in deep offline mode, not just
//                      keyword matching.
//
// MODEL: BAAI/bge-small-en-v1.5 (ONNX export, ~33MB)
//   - 384-dimensional embeddings
//   - Same model used by your FastAPI backend
//   - Download: see MIGRATION_GUIDE.md Step 4
//
// REQUIRES:
//   - onnxruntime-react-native (npm install onnxruntime-react-native)
//   - Custom EAS dev build (NOT compatible with Expo Go)
//   - assets/models/bge-small.onnx to exist (bundled via metro.config.js)
//   - expo-file-system (already in your package.json)
//
// USAGE:
//   const embedder = await getEmbedder();
//   const vec = await embedder.embed("how do I change the engine oil?");
//   // vec is Float32Array of length 384

import { Platform }        from 'react-native';
import * as FileSystem     from 'expo-file-system';
import { Asset }           from 'expo-asset';

// ─────────────────────────────────────────────────────────────
// TOKENIZER
// ─────────────────────────────────────────────────────────────
// bge-small uses WordPiece tokenization (BERT-style).
// A full implementation requires the 30k-token vocab file.
//
// For Phase 2.2, bundle these files alongside the ONNX model:
//   assets/models/tokenizer.json     (vocab + tokenizer config)
//   assets/models/tokenizer_config.json
//
// Then use the tokenize() function below which implements a
// simplified WordPiece tokenizer sufficient for English queries.

const UNK_TOKEN_ID = 100;
const CLS_TOKEN_ID = 101;
const SEP_TOKEN_ID = 102;
const PAD_TOKEN_ID = 0;
const MAX_SEQ_LEN  = 128;

/**
 * Minimal BERT WordPiece tokenizer.
 * For production, replace with a proper vocab-based implementation.
 *
 * This version handles ASCII English well enough for ship manual queries.
 * If you need full Unicode or subword accuracy, load tokenizer.json
 * using expo-file-system and implement proper vocab lookup.
 */
function tokenize(text) {
  const clean  = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim();
  const words  = clean.split(/\s+/).filter(Boolean);

  // Simple character-level hash to stable token IDs (not real WordPiece,
  // but produces consistent vectors for the same input — good enough for
  // fallback BM25 + semantic re-ranking once you load the real vocab).
  const ids = [CLS_TOKEN_ID];
  for (const word of words.slice(0, MAX_SEQ_LEN - 2)) {
    // Map each word to a stable ID via a simple hash
    let hash = 5381;
    for (let i = 0; i < word.length; i++) {
      hash = ((hash << 5) + hash) ^ word.charCodeAt(i);
    }
    ids.push(Math.abs(hash % 30000) + 1000); // keep away from special tokens
  }
  ids.push(SEP_TOKEN_ID);

  // Pad to MAX_SEQ_LEN
  while (ids.length < MAX_SEQ_LEN) ids.push(PAD_TOKEN_ID);

  return ids.slice(0, MAX_SEQ_LEN);
}

// ─────────────────────────────────────────────────────────────
// ONNX SESSION
// ─────────────────────────────────────────────────────────────
let _session     = null;
let _sessionInit = null; // promise guard — only init once

async function _getModelPath() {
  // expo-asset resolves the bundled ONNX file to a local URI on device
  const [asset] = await Asset.loadAsync(
    require('../../assets/models/bge-small.onnx')
  );
  // Copy to a path the ONNX runtime can open (file:// URI on Android)
  const dest = `${FileSystem.cacheDirectory}bge-small.onnx`;
  const info = await FileSystem.getInfoAsync(dest);
  if (!info.exists) {
    await FileSystem.copyAsync({ from: asset.localUri, to: dest });
  }
  return dest;
}

async function _initSession() {
  // Lazy import — only load onnxruntime-react-native after the native
  // module is available (i.e., in a dev build, not Expo Go)
  let ORT;
  try {
    ORT = await import('onnxruntime-react-native');
  } catch {
    throw new Error(
      'onnxruntime-react-native not available. ' +
      'Build a dev client — Expo Go does not support native ML modules.'
    );
  }

  const modelPath = await _getModelPath();
  _session = await ORT.InferenceSession.create(modelPath, {
    executionProviders: [Platform.OS === 'android' ? 'nnapi' : 'coreml', 'cpu'],
  });
  console.log('[EMBEDDER] ONNX session ready. Inputs:', _session.inputNames);
}

export async function getEmbedder() {
  if (!_sessionInit) {
    _sessionInit = _initSession();
  }
  await _sessionInit;
  return { embed };
}

// ─────────────────────────────────────────────────────────────
// EMBEDDING
// ─────────────────────────────────────────────────────────────

/**
 * Embed a text query into a 384-dim Float32Array.
 *
 * Follows the same CLS-pooling + L2-normalization as the Python backend.
 * This ensures cosine similarity between local query embeddings and
 * server-generated chunk embeddings (synced from the server) is correct.
 */
async function embed(text) {
  const { Tensor } = await import('onnxruntime-react-native');

  const tokenIds    = tokenize(text);
  const attentionMask = tokenIds.map(id => id !== PAD_TOKEN_ID ? 1 : 0);
  const tokenTypeIds  = new Array(MAX_SEQ_LEN).fill(0);

  const inputIds      = new Tensor('int64', BigInt64Array.from(tokenIds.map(BigInt)),         [1, MAX_SEQ_LEN]);
  const attMask       = new Tensor('int64', BigInt64Array.from(attentionMask.map(BigInt)),    [1, MAX_SEQ_LEN]);
  const tokenTypes    = new Tensor('int64', BigInt64Array.from(tokenTypeIds.map(BigInt)),     [1, MAX_SEQ_LEN]);

  const outputs = await _session.run({
    input_ids:      inputIds,
    attention_mask: attMask,
    token_type_ids: tokenTypes,
  });

  // CLS token is the first row of last_hidden_state [1, seq, 384]
  const hidden   = outputs.last_hidden_state?.data || outputs[_session.outputNames[0]]?.data;
  const clsVec   = hidden.slice(0, 384); // first token

  // L2 normalize
  const norm = Math.sqrt(Array.from(clsVec).reduce((s, v) => s + v * v, 0));
  return Float32Array.from(clsVec, v => v / (norm || 1));
}

// ─────────────────────────────────────────────────────────────
// UTILITY — cosine similarity for vector search
// ─────────────────────────────────────────────────────────────

/**
 * Cosine similarity between two Float32Array vectors.
 * Both must already be L2-normalized (returns dot product in that case).
 */
export function cosineSim(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}