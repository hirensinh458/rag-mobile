#!/usr/bin/env bash
set -euo pipefail

MODEL_DIR="assets/models"
MODEL_PATH="$MODEL_DIR/bge-small.onnx"

# ── Download bge-small.onnx from HuggingFace ────────────────────
if [ ! -f "$MODEL_PATH" ]; then
  echo "[pre-install] Downloading bge-small.onnx (~127MB) from HuggingFace..."
  mkdir -p "$MODEL_DIR"
  curl -L \
    --retry 3 \
    --retry-delay 5 \
    --progress-bar \
    "https://huggingface.co/BAAI/bge-small-en-v1.5/resolve/main/onnx/model.onnx" \
    -o "$MODEL_PATH"
  echo "[pre-install] ✅ Model downloaded: $(du -sh $MODEL_PATH | cut -f1)"
else
  echo "[pre-install] ✅ bge-small.onnx already present, skipping"
fi

# ── Verify the download isn't corrupted (should be ~127MB) ───────
FILE_SIZE=$(wc -c < "$MODEL_PATH")
if [ "$FILE_SIZE" -lt 10000000 ]; then
  echo "[pre-install] ❌ FATAL: bge-small.onnx is too small (${FILE_SIZE} bytes) — download likely failed"
  exit 1
fi

echo "[pre-install] ✅ All model assets ready"