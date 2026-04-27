// src/offline/embedder.js
//
// FIXES in this version:
//
//   FIX 1 — expo-file-system/legacy import
//     PROBLEM: Importing from "expo-file-system" (new API) fires a deprecation
//              warning as a side-effect during module evaluation. That warning
//              string becomes the caught .message in getLocalEmbedder(), completely
//              masking the real ONNX error and making BM25-only mode look like a
//              file-system issue.
//     FIX: Import from "expo-file-system/legacy" everywhere in this file.
//
//   FIX 2 — _sessionInit promise never cleared on failure
//     PROBLEM: If _initSession() throws, _sessionInit is left pointing at the
//              rejected promise. Every subsequent call to getEmbedder() awaits
//              the same rejection forever — the embedder can never recover.
//     FIX: Attach a .catch() on _sessionInit that resets _sessionInit = null
//          so the next call retries from scratch.
//
//   FIX 3 — Use real WordPiece tokenizer from tokenizer.js
//     PROBLEM: The fake character-hash tokenize() in this file produces token IDs
//              that have nothing to do with the real bge-small vocab. Vectors are
//              in a completely different space from server-generated chunk vectors,
//              so KNN results are essentially random even if the ONNX session runs.
//     FIX: Import tokenize() from tokenizer.js (real WordPiece + vocab.txt).
//          Prerequisite: bundle assets/models/vocab.txt (see tokenizer.js header).
//
//   KEPT — All Phase 2.2 ONNX session logic, CLS pooling, L2 normalisation,
//           cosineSim utility, Asset-based model path resolution.

import { Platform }        from 'react-native';
import * as FileSystem     from 'expo-file-system/legacy';   // FIX 1: use legacy API
import { Asset }           from 'expo-asset';
import { tokenize }        from './tokenizer';               // FIX 3: real WordPiece

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────

const MAX_SEQ_LEN = 128;
const PAD_TOKEN_ID = 0;

// ─────────────────────────────────────────────────────────────
// ONNX SESSION — singleton, promise-guarded
// ─────────────────────────────────────────────────────────────

let _session     = null;
let _sessionInit = null;

async function _getModelPath() {
  const [asset] = await Asset.loadAsync(
    require('../../assets/models/bge-small.onnx')
  );
  const dest = `${FileSystem.cacheDirectory}bge-small.onnx`;
  const info = await FileSystem.getInfoAsync(dest);
  if (!info.exists) {
    await FileSystem.copyAsync({ from: asset.localUri, to: dest });
  }
  return dest;
}

async function _initSession() {
  // Lazy import — onnxruntime-react-native requires a custom dev/prod build.
  // Expo Go does NOT include the JSI native module and will throw here.
  let ORT;
  try {
    ORT = await import('onnxruntime-react-native');
  } catch (e) {
    throw new Error(
      'onnxruntime-react-native not available — ' +
      'build a dev client (npx expo run:android). ' +
      'Expo Go does not support native ML modules. ' +
      `Original: ${e.message}`
    );
  }

  const modelPath = await _getModelPath();

  _session = await ORT.InferenceSession.create(modelPath, {
    executionProviders: [
      Platform.OS === 'android' ? 'nnapi' : 'coreml',
      'cpu',
    ],
  });

  console.log('[EMBEDDER] ONNX session ready. Inputs:', _session.inputNames);
}

/**
 * Returns the embedder singleton { embed }.
 *
 * FIX 2: If _initSession() rejects, _sessionInit is cleared so the next call
 * retries instead of re-throwing the same stale rejection forever.
 */
export async function getEmbedder() {
  if (!_sessionInit) {
    _sessionInit = _initSession().catch(err => {
      // FIX 2: clear promise so the next call can retry
      _sessionInit = null;
      _session     = null;
      throw err;
    });
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
 * Uses the real WordPiece tokenizer (tokenizer.js) so token IDs match
 * the Python `tokenizers` library and vectors live in the same space
 * as server-generated chunk vectors.
 *
 * CLS pooling + L2 normalisation matches the Python backend exactly.
 */
async function embed(text) {
  if (!_session) throw new Error('[EMBEDDER] Session not initialised');

  const { Tensor } = await import('onnxruntime-react-native');

  // FIX 3: real vocab-based tokenization (async — loads vocab.txt once)
  const tokenIds      = await tokenize(text);
  const attentionMask = tokenIds.map(id => id !== PAD_TOKEN_ID ? 1 : 0);
  const tokenTypeIds  = new Array(MAX_SEQ_LEN).fill(0);

  // bge-small expects int64 tensors
  const inputIds   = new Tensor('int64', BigInt64Array.from(tokenIds.map(BigInt)),          [1, MAX_SEQ_LEN]);
  const attMask    = new Tensor('int64', BigInt64Array.from(attentionMask.map(BigInt)),      [1, MAX_SEQ_LEN]);
  const tokenTypes = new Tensor('int64', BigInt64Array.from(tokenTypeIds.map(BigInt)),       [1, MAX_SEQ_LEN]);

  const outputs = await _session.run({
    input_ids:      inputIds,
    attention_mask: attMask,
    token_type_ids: tokenTypes,
  });

  // CLS token = first row of last_hidden_state [1, seq, 384]
  const hidden = outputs.last_hidden_state?.data
              ?? outputs[_session.outputNames[0]]?.data;

  if (!hidden || hidden.length < 384) {
    throw new Error(`[EMBEDDER] Unexpected model output shape: ${hidden?.length}`);
  }

  const clsVec = hidden.slice(0, 384);

  // L2 normalise — matches Python backend's normalisation
  const norm = Math.sqrt(Array.from(clsVec).reduce((s, v) => s + v * v, 0));
  return Float32Array.from(clsVec, v => v / (norm || 1));
}

// ─────────────────────────────────────────────────────────────
// UTILITY
// ─────────────────────────────────────────────────────────────

/**
 * Cosine similarity between two L2-normalised Float32Array vectors.
 * Since both are unit vectors, this is just the dot product.
 */
export function cosineSim(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}