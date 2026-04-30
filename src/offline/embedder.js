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
//   FIX 4 — [TypeError: Cannot read property 'install' of null]
//     ROOT CAUSE (confirmed by reading onnxruntime-react-native/dist/module/binding.js):
//
//       export const Module = NativeModules.Onnxruntime;  // ← can be null
//       if (typeof globalThis.OrtApi === 'undefined') {
//         Module.install();   // ← CRASHES here when Module is null
//       }
//
//       This code runs at module evaluation time — the instant `import()`
//       causes the JS bundle to execute binding.js. There is no lazy path.
//       If NativeModules.Onnxruntime is null (native build not linked, or
//       Expo Go), Module is null and Module.install() throws immediately.
//       No amount of retrying the import() call after a delay can avoid this
//       because Metro caches the evaluated module; re-importing just returns
//       the same already-crashed module object.
//
//     FIX:
//       Pre-flight check using React Native's NativeModules BEFORE calling
//       import('onnxruntime-react-native'). NativeModules is populated
//       synchronously during the native bridge setup, so checking
//       NativeModules.Onnxruntime !== null tells us with certainty whether
//       the native module was compiled into the build. If it is null, we
//       throw a clear descriptive error immediately — before the import()
//       ever fires — so BM25-only fallback kicks in cleanly with no crash.
//
//     ALSO FIXED: embed() was calling `await import('onnxruntime-react-native')`
//       a second time just to obtain `Tensor`. This second import re-evaluates
//       binding.js on certain Metro fast-refresh cycles and can crash again.
//       Fix: store the ORT module reference in _ort at init time; embed()
//       reads _ort.Tensor directly with no second import().

import { Platform, NativeModules } from 'react-native';  // FIX 4: need NativeModules
import * as FileSystem from 'expo-file-system/legacy';   // FIX 1: use legacy API
import { Asset }       from 'expo-asset';
import { tokenize }    from './tokenizer';               // FIX 3: real WordPiece
import { TurboModuleRegistry } from 'react-native';
// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────

const MAX_SEQ_LEN  = 128;
const PAD_TOKEN_ID = 0;

// ─────────────────────────────────────────────────────────────
// ONNX SESSION — singleton, promise-guarded
// ─────────────────────────────────────────────────────────────

let _session     = null;
let _sessionInit = null;
let _ort         = null;  // FIX 4: store ORT module reference at init time

async function _getModelPath() {
  // The file is now placed in the APK's root assets/ folder by withModelAssets plugin.
  // We can copy it to the cache directory using FileSystem.
  const assetUri = 'asset:///models/bge-small.onnx';  // points to assets/models/bge-small.onnx
  const dest = `${FileSystem.cacheDirectory}bge-small.onnx`;
  const info = await FileSystem.getInfoAsync(dest);
  if (!info.exists) {
    // Download/copy the asset to the cache dir
    await FileSystem.copyAsync({
      from: assetUri,
      to: dest,
    });
  }
  return dest;
}

/**
 * FIX 4: Pre-flight guard — check NativeModules.Onnxruntime BEFORE importing.
 *
 * onnxruntime-react-native/dist/module/binding.js does this at module eval time:
 *
 *   export const Module = NativeModules.Onnxruntime;
 *   if (typeof globalThis.OrtApi === 'undefined') {
 *     Module.install();   // crashes if Module (NativeModules.Onnxruntime) is null
 *   }
 *
 * NativeModules is synchronously populated by the native bridge before any JS
 * runs. If NativeModules.Onnxruntime is null here, it will still be null when
 * binding.js evaluates — and Module.install() will throw "Cannot read property
 * 'install' of null". We catch this before it happens.
 */
async function _importORT() {
  // FIX 4: synchronous pre-flight — no import needed to check this
  const _OrtModule = TurboModuleRegistry.get('Onnxruntime') ?? NativeModules.Onnxruntime;
  if (!_OrtModule) {
    throw new Error(
      'NativeModules.Onnxruntime is null — the onnxruntime-react-native native ' +
      'module was not compiled into this build. ' +
      'You must use a custom dev client, not Expo Go. ' +
      'Run: npx expo run:android   (or npx expo run:android --clear for a clean build)'
    );
  }

  // Safe to import now — NativeModules.Onnxruntime is present so install() won't crash
  let mod;
  try {
    mod = await import('onnxruntime-react-native');
  } catch (e) {
    throw new Error(
      `onnxruntime-react-native import failed after pre-flight passed: ${e.message}`
    );
  }

  // Sanity check: OrtApi should have been installed into globalThis by now
  if (!mod || typeof globalThis.OrtApi === 'undefined') {
    throw new Error(
      'onnxruntime-react-native loaded but OrtApi was not installed into globalThis. ' +
      'The JSI install step failed silently. ' +
      'Try a clean rebuild: npx expo run:android --clear'
    );
  }

  return mod;
}

async function _initSession() {
  const ORT = await _importORT();  // FIX 4: safe loader with pre-flight

  const modelPath = await _getModelPath();

  _session = await ORT.InferenceSession.create(modelPath, {
    executionProviders: [
      Platform.OS === 'android' ? 'nnapi' : 'coreml',
      'cpu',
    ],
  });

  _ort = ORT;  // FIX 4: persist so embed() never re-imports

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
      // FIX 2: clear so the next call can retry from scratch
      _sessionInit = null;
      _session     = null;
      _ort         = null;
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
 *
 * FIX 4: Uses _ort.Tensor directly — no second dynamic import() call,
 * which previously could re-trigger the binding.js crash on fast-refresh.
 */
async function embed(text) {
  if (!_session) throw new Error('[EMBEDDER] Session not initialised');
  if (!_ort)     throw new Error('[EMBEDDER] ORT module reference lost');

  const { Tensor } = _ort;  // FIX 4: use stored reference, never re-import

  // FIX 3: real vocab-based tokenization (async — loads vocab.txt once)
  const tokenIds      = await tokenize(text);
  const attentionMask = tokenIds.map(id => id !== PAD_TOKEN_ID ? 1 : 0);
  const tokenTypeIds  = new Array(MAX_SEQ_LEN).fill(0);

  // bge-small expects int64 tensors
  const inputIds   = new Tensor('int64', BigInt64Array.from(tokenIds.map(BigInt)),      [1, MAX_SEQ_LEN]);
  const attMask    = new Tensor('int64', BigInt64Array.from(attentionMask.map(BigInt)), [1, MAX_SEQ_LEN]);
  const tokenTypes = new Tensor('int64', BigInt64Array.from(tokenTypeIds.map(BigInt)),  [1, MAX_SEQ_LEN]);

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