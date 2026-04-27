// metro.config.js
//
// CHANGES:
//   - Added 'onnx' so Metro bundles the bge-small.onnx model (was already here)
//   - Added 'json' so Metro bundles tokenizer.json and tokenizer_config.json
//     from assets/models/ as static assets (needed by P0 WordPiece tokenizer)
//
// assets/models/ should contain after P0 setup:
//   bge-small.onnx         (~33 MB)
//   vocab.txt              (~230 KB)   ← downloaded from HuggingFace
//   tokenizer.json         (~760 KB)   ← downloaded from HuggingFace
//   tokenizer_config.json  (~1 KB)     ← downloaded from HuggingFace

const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Allow Metro to resolve and bundle .onnx binary files and .json model files
config.resolver.assetExts.push('onnx', 'json');

module.exports = config;