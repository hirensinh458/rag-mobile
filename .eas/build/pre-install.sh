#!/usr/bin/env bash
set -euo pipefail

MODEL_DIR="assets/models"
EMBEDDER_PATH="$MODEL_DIR/bge-small.onnx"
RERANKER_PATH="$MODEL_DIR/reranker.onnx"

# ── Download bge-small.onnx from HuggingFace ────────────────────
if [ ! -f "$EMBEDDER_PATH" ]; then
  echo "[pre-install] Downloading bge-small.onnx (~127MB) from HuggingFace..."
  mkdir -p "$MODEL_DIR"
  curl -L \
    --retry 3 \
    --retry-delay 5 \
    --progress-bar \
    "https://huggingface.co/BAAI/bge-small-en-v1.5/resolve/main/onnx/model.onnx" \
    -o "$EMBEDDER_PATH"
  echo "[pre-install] ✅ Embedder downloaded: $(du -sh $EMBEDDER_PATH | cut -f1)"
else
  echo "[pre-install] ✅ bge-small.onnx already present, skipping"
fi

# ── Verify embedder isn't corrupted (should be ~127MB) ───────────
FILE_SIZE=$(wc -c < "$EMBEDDER_PATH")
if [ "$FILE_SIZE" -lt 10000000 ]; then
  echo "[pre-install] ❌ FATAL: bge-small.onnx is too small (${FILE_SIZE} bytes) — download likely failed"
  exit 1
fi

# ── Download correct FP32 non‑quantized cross‑encoder ONNX ─────
RERANKER_PATH="assets/models/reranker.onnx"
# SHA256 of the CORRECT model (pre‑computed from the svilupp zip)
EXPECTED_SHA256="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

echo "[pre-install] Removing any old reranker.onnx to force fresh download"
rm -f "$RERANKER_PATH"

echo "[pre-install] Downloading correct reranker ONNX (FP32, ~83MB)..."
mkdir -p "$MODEL_DIR"

curl -L --retry 5 --retry-delay 10 --progress-bar \
  "https://huggingface.co/svilupp/onnx-cross-encoders/resolve/main/ms-marco-MiniLM-L-6-v2-onnx.zip" \
| funzip | tar -xO '*/ms-marco-MiniLM-L-6-v2.onnx' > "$RERANKER_PATH"

# Verify size
FILE_SIZE=$(wc -c < "$RERANKER_PATH")
if [ "$FILE_SIZE" -lt 80000000 ]; then
  echo "[pre-install] ❌ FATAL: reranker.onnx is too small (${FILE_SIZE} bytes)"
  exit 1
fi
echo "[pre-install] ✅ FP32 reranker downloaded: ${FILE_SIZE} bytes"

# ── Verify reranker isn't corrupted (should be ~85MB) ────────────
FILE_SIZE=$(wc -c < "$RERANKER_PATH")
if [ "$FILE_SIZE" -lt 10000000 ]; then
  echo "[pre-install] ❌ FATAL: reranker.onnx is too small (${FILE_SIZE} bytes) — download likely failed"
  exit 1
fi

echo "[pre-install] ✅ All model assets ready"