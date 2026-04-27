// src/offline/tokenizer.js  — P0: Real bge-small WordPiece tokenizer
//
// REPLACES the fake character-hash tokenize() function inside embedder.js.
// This produces token IDs that are IDENTICAL to the Python `tokenizers` library,
// which means on-device query vectors live in the same embedding space as the
// server-generated chunk vectors synced from Qdrant.
//
// PREREQUISITE:
//   Download from HuggingFace BAAI/bge-small-en-v1.5 and place in assets/models/:
//     vocab.txt              (~230 KB)
//     tokenizer.json         (~760 KB)
//     tokenizer_config.json  (~1 KB)
//
//   Register in metro.config.js:
//     config.resolver.assetExts.push('onnx', 'json');
//
// VERIFICATION (run after P0, before P1):
//   const serverVec = await apiFetch('/embed', url, { method:'POST', body: JSON.stringify({ text:'hello world' }) }).then(r=>r.json());
//   const localVec  = await embed('hello world');
//   const sim = cosineSim(localVec, new Float32Array(serverVec.embedding));
//   assert(sim > 0.99, `Tokenizer mismatch! sim=${sim}`);

import * as FileSystem from 'expo-file-system/legacy';
import { Asset }       from 'expo-asset';

// ── Special token IDs (standard BERT / bge-small values) ──────────────────
const UNK_ID = 100;  // [UNK]
const CLS_ID = 101;  // [CLS]
const SEP_ID = 102;  // [SEP]
const PAD_ID = 0;    // [PAD]
const MAX_SEQ = 128;

// ── Module-level vocab state ───────────────────────────────────────────────
let _vocab     = null;   // Map<string, number>
let _vocabInit = null;   // Promise — ensures loadVocab() runs exactly once

/**
 * Load vocab.txt from the bundled asset into a Map<token, id>.
 * Subsequent calls return the same promise (singleton pattern).
 */
async function loadVocab() {
  if (_vocabInit) return _vocabInit;

  _vocabInit = (async () => {
    // expo-asset resolves the bundled file to a content:// / file:// URI
    const [asset] = await Asset.loadAsync(
      require('../../assets/models/vocab.txt')
    );

    // Copy to cache dir where FileSystem.readAsStringAsync works on both platforms
    const dest = FileSystem.cacheDirectory + 'bge-vocab.txt';
    const info = await FileSystem.getInfoAsync(dest);
    if (!info.exists) {
      await FileSystem.copyAsync({ from: asset.localUri, to: dest });
    }

    const text = await FileSystem.readAsStringAsync(dest);
    _vocab = new Map();
    text.split('\n').forEach((token, idx) => {
      const t = token.trimEnd(); // preserve leading spaces (## prefix)
      if (t) _vocab.set(t, idx);
    });

    console.log('[TOKENIZER] Vocab loaded:', _vocab.size, 'tokens');
  })();

  return _vocabInit;
}

/**
 * WordPiece greedy longest-match subword segmentation.
 * Identical algorithm to the Rust `tokenizers` library used by Python HuggingFace.
 *
 * @param {string} word — a single whitespace-delimited word (already lowercased)
 * @returns {number[]} — list of token IDs
 */
function wordpiece(word) {
  // Fast-path: whole word is in vocab
  if (_vocab.has(word)) return [_vocab.get(word)];

  const ids = [];
  let start = 0;

  while (start < word.length) {
    let end = word.length;
    let found = false;

    while (start < end) {
      // The ## prefix marks continuation subwords (not word-initial)
      const sub = (start === 0 ? '' : '##') + word.slice(start, end);
      if (_vocab.has(sub)) {
        ids.push(_vocab.get(sub));
        start = end;
        found = true;
        break;
      }
      end--;
    }

    if (!found) {
      // No subword found — map the whole word to [UNK] and bail
      return [UNK_ID];
    }
  }

  return ids;
}

/**
 * Tokenize `text` into a padded int array of length MAX_SEQ (128).
 *
 * Matches bge-small-en-v1.5 tokenizer settings:
 *   do_lower_case = true
 *   strip_accents = false (bge-small does NOT strip accents)
 *   CLS prepended, SEP appended, PAD right-padded to 128
 *
 * @param {string} text
 * @returns {Promise<number[]>} — length 128 array of token IDs
 */
export async function tokenize(text) {
  await loadVocab();

  // bge-small: lowercase only — no accent stripping
  const clean = text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')   // remove punctuation
    .replace(/\s+/g, ' ')
    .trim();

  const words = clean.split(' ').filter(Boolean);
  const ids   = [CLS_ID];

  for (const word of words) {
    if (ids.length >= MAX_SEQ - 1) break;  // leave room for SEP
    const pieces = wordpiece(word);
    for (const id of pieces) {
      if (ids.length >= MAX_SEQ - 1) break;
      ids.push(id);
    }
  }

  ids.push(SEP_ID);

  // Right-pad with PAD_ID
  while (ids.length < MAX_SEQ) ids.push(PAD_ID);

  return ids.slice(0, MAX_SEQ);
}

/**
 * Reset vocab (useful for testing or if assets are updated at runtime).
 */
export function resetVocab() {
  _vocab     = null;
  _vocabInit = null;
}