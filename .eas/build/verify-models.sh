#!/usr/bin/env bash
set -euo pipefail

MODEL="$PWD/android/app/src/main/assets/models/reranker.onnx"
if [ -f "$MODEL" ]; then
  SIZE=$(wc -c < "$MODEL")
  echo "[verify-models] reranker.onnx in android assets: ${SIZE} bytes"
  if [ "$SIZE" -lt 80000000 ]; then
    echo "[verify-models] ❌ FATAL: bundled reranker is too small!"
    exit 1
  fi
else
  echo "[verify-models] ⚠ reranker.onnx not found in android assets — may not be bundled"
fi