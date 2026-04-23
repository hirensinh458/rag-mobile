// src/config/index.js
//
// CHANGE: Added CLOUD_URL and LOCAL_URL for the three-URL network architecture.
//   CLOUD_URL — primary server (Mode 1 with internet, Mode 2 without)
//   LOCAL_URL — fallback server (used when cloud is unreachable)
//   API_BASE_URL — kept for backward compat; used as final fallback

export const Config = {
  // Network — three-URL architecture
  API_BASE_URL: process.env.EXPO_PUBLIC_API_BASE_URL || 'http://10.0.2.2:8000',
  CLOUD_URL:    process.env.EXPO_PUBLIC_CLOUD_URL    || '',   // empty = no cloud server
  LOCAL_URL:    process.env.EXPO_PUBLIC_LOCAL_URL    || '',   // empty = use API_BASE_URL

  CONNECTIVITY_CHECK_TIMEOUT_MS: 4000,   // abort health probe after 4s (was 5s)
  CONNECTIVITY_POLL_INTERVAL_MS: 15000,  // re-probe every 15s (was 30s)

  // Sync
  SYNC_INTERVAL_MS: parseInt(process.env.EXPO_PUBLIC_SYNC_INTERVAL_MS || '300000'),

  // Retrieval — mirrors your Python backend values exactly
  OFFLINE_TOP_K:    10,   // raised from 5 to compensate for FTS5 vocabulary sparsity
  RETRIEVAL_FETCH_K: 20,
  MMR_THRESHOLD:    0.70,
  RRF_K:            60,

  // Features
  OFFLINE_MODE_ENABLED: process.env.EXPO_PUBLIC_OFFLINE_MODE_ENABLED === 'true',
  PDF_VIEWER_ENABLED:   process.env.EXPO_PUBLIC_ENABLE_PDF_VIEWER   === 'true',

  // ML (Phase 2+)
  ONNX_MODEL_PATH: process.env.EXPO_PUBLIC_ONNX_MODEL_PATH || 'bge-small.onnx',
  EMBEDDING_DIM:   parseInt(process.env.EXPO_PUBLIC_EMBEDDING_DIM || '384'),
};