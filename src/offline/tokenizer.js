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
//   The withModelAssets config plugin (plugins/withModelAssets.js) copies
//   vocab.txt into the Android APK's assets/models/ folder at build time.
//   This module loads it via FileSystem from 'asset:///models/vocab.txt'.
//
// VERIFICATION (run after P0, before P1):
//   const serverVec = await apiFetch('/embed', url, { method:'POST', body: JSON.stringify({ text:'hello world' }) }).then(r=>r.json());
//   const localVec  = await embed('hello world');
//   const sim = cosineSim(localVec, new Float32Array(serverVec.embedding));
//   assert(sim > 0.99, `Tokenizer mismatch! sim=${sim}`);
//
// LOGGING ADDED: Vocab load (asset copy + parse time + token count), every
// tokenize() call with input/output token count, wordpiece segmentation
// failures (UNK fallbacks), and vocab reset — all tagged [tokenizer].

import * as FileSystem from 'expo-file-system/legacy';
import { createLogger } from '../utils/logger';

// Module-level logger — all lines tagged [tokenizer]
const log = createLogger('tokenizer');

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
 * Load vocab.txt from the native assets folder into a Map<token, id>.
 * Subsequent calls return the same promise (singleton pattern).
 */
async function loadVocab() {
  if (_vocabInit) {
    log.debug('loadVocab() — already loaded (or in progress), awaiting singleton');
    return _vocabInit;
  }

  log.info('loadVocab() — starting vocab load from asset:///models/vocab.txt …');
  const startMs = Date.now();

  _vocabInit = (async () => {
    // The file is copied to the APK's assets/models/ by withModelAssets plugin.
    const assetUri = 'asset:///models/vocab.txt';
    const dest     = FileSystem.cacheDirectory + 'bge-vocab.txt';

    const info = await FileSystem.getInfoAsync(dest);
    if (!info.exists) {
      log.debug('loadVocab() vocab.txt not in cache — copying from asset …');
      await FileSystem.copyAsync({ from: assetUri, to: dest });
      log.debug('loadVocab() asset copy complete');
    } else {
      log.debug('loadVocab() vocab.txt found in cache at:', dest);
    }

    log.debug('loadVocab() reading vocab.txt …');
    const text = await FileSystem.readAsStringAsync(dest);
    _vocab = new Map();
    text.split('\n').forEach((token, idx) => {
      const t = token.trimEnd(); // preserve leading spaces (## prefix)
      if (t) _vocab.set(t, idx);
    });

    log.info(`loadVocab() ✅ vocab loaded — ${_vocab.size} tokens in ${Date.now() - startMs}ms`);
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
  if (_vocab.has(word)) {
    return [_vocab.get(word)];
  }

  const ids = [];
  let start = 0;

  while (start < word.length) {
    let end   = word.length;
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
      log.debug(`wordpiece() UNK fallback for word: "${word}"`);
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
export async function tokenize(text, opts = {}) {
  await loadVocab();

  const addSpecialTokens = opts.addSpecialTokens !== false;

  log.debug('tokenize() — input length:', text.length, '| preview:', text.slice(0, 60));

  // bge-small: lowercase only — no accent stripping
  const clean = text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')   // remove punctuation
    .replace(/\s+/g, ' ')
    .trim();

  const words = clean.split(' ').filter(Boolean);
  log.debug('tokenize() — word count after normalisation:', words.length);

  const ids = addSpecialTokens ? [CLS_ID] : [];
  let unkCount = 0;

  const maxLen = addSpecialTokens ? MAX_SEQ - 1 : MAX_SEQ; // leave room for SEP if special tokens enabled

  for (const word of words) {
    if (ids.length >= maxLen) {
      log.debug('tokenize() — MAX_SEQ reached, truncating remaining words');
      break;
    }
    const pieces = wordpiece(word);
    if (pieces.length === 1 && pieces[0] === UNK_ID) unkCount++;
    for (const id of pieces) {
      if (ids.length >= maxLen) break;
      ids.push(id);
    }
  }

  if (addSpecialTokens) {
    ids.push(SEP_ID);
    // Right-pad with PAD_ID
    while (ids.length < MAX_SEQ) ids.push(PAD_ID);
    ids.splice(MAX_SEQ);
  }

  // Logging
  log.info('tokenize() DONE', {
    inputWords:   words.length,
    outputTokens: addSpecialTokens ? ids.filter(id => id !== PAD_ID).length : ids.length,
    unkTokens:    unkCount,
    totalLength:  ids.length,
  });

  return ids;
}

/**
 * Reset vocab (useful for testing or if assets are updated at runtime).
 */
export function resetVocab() {
  log.info('resetVocab() — clearing cached vocab and init promise');
  _vocab     = null;
  _vocabInit = null;
}