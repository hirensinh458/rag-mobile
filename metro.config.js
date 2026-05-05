const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.resolver.assetExts.push('onnx');

// Tell Metro to handle these extensions as assets (not parse them)
config.resolver.assetExts.push('onnx', 'bin', 'dylib', 'txt');

// Exclude large model files from the file watcher entirely
// Metro will still bundle them when explicitly require()'d
config.watchFolders = [__dirname];
config.resolver.blockList = [
  // Block Metro from scanning the native-libs folder (raw .so files)
  /native-libs\/.*/,
];

// ⭐ Increase max asset size to accommodate the 90 MB ONNX model
config.server = {
  ...config.server,
  maxAssetSize: 157286400,   // 150 * 1024 * 1024 = 157,286,400  bytes
};

module.exports = config;