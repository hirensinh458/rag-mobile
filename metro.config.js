// metro.config.js
//
// CHANGE: Added 'onnx' to assetExts so Metro bundles the bge-small.onnx
// model file as a static asset. Without this, require('../../assets/models/bge-small.onnx')
// in embedder.js throws "unknown module type" during the build.

const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Allow Metro to resolve and bundle .onnx binary files as static assets
config.resolver.assetExts.push('onnx');

module.exports = config;