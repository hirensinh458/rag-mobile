export const Config = {
  // Network
  API_BASE_URL: process.env.EXPO_PUBLIC_API_BASE_URL || 'http://10.0.2.2:8000',
  CONNECTIVITY_CHECK_TIMEOUT_MS: 5000,

  // Sync
  SYNC_INTERVAL_MS: parseInt(process.env.EXPO_PUBLIC_SYNC_INTERVAL_MS || '300000'),

  // Retrieval — mirrors your Python backend values exactly
  OFFLINE_TOP_K: 5,
  RETRIEVAL_FETCH_K: 20,
  MMR_THRESHOLD: 0.70,
  RRF_K: 60,

  // Features
  OFFLINE_MODE_ENABLED: process.env.EXPO_PUBLIC_OFFLINE_MODE_ENABLED === 'true',
  PDF_VIEWER_ENABLED:   process.env.EXPO_PUBLIC_ENABLE_PDF_VIEWER === 'true',

  // ML (used Phase 2+)
  ONNX_MODEL_PATH: process.env.EXPO_PUBLIC_ONNX_MODEL_PATH || 'bge-small.onnx',
  EMBEDDING_DIM:   parseInt(process.env.EXPO_PUBLIC_EMBEDDING_DIM || '384'),
};