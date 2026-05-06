#!/usr/bin/env bash
# scripts/pre-install.sh
#
# Downloads the bge-small embedding model and the Xenova
# cross-encoder reranker model from Hugging Face.
# Verifies file sizes to catch incomplete downloads early.

set -euo pipefail

MODEL_DIR="assets/models"
EMBEDDER_PATH="$MODEL_DIR/bge-small.onnx"
RERANKER_PATH="$MODEL_DIR/reranker.onnx"

# ── Download bge-small.onnx ─────────────────────────────────────────────────
if [ ! -f "$EMBEDDER_PATH" ]; then
  echo "[pre-install] Downloading bge-small.onnx (~127MB) from HuggingFace (ProTiger123)..."
  mkdir -p "$MODEL_DIR"
  curl -L \
    --retry 3 \
    --retry-delay 5 \
    --progress-bar \
    "https://huggingface.co/ProTiger123/bge-small-pooled-onnx/resolve/main/model.onnx" \
    -o "$EMBEDDER_PATH"
  echo "[pre-install] ✅ Embedder downloaded: $(du -sh "$EMBEDDER_PATH" | cut -f1)"
else
  echo "[pre-install] ✅ bge-small.onnx already present, skipping"
fi

# Verify embedder size
FILE_SIZE=$(wc -c < "$EMBEDDER_PATH")
if [ "$FILE_SIZE" -lt 10000000 ]; then
  echo "[pre-install] ❌ FATAL: bge-small.onnx is too small (${FILE_SIZE} bytes) — download likely failed"
  exit 1
fi

# ── Download Xenova ms-marco-TinyBERT-L-2-v2 ONNX reranker ─────────────────
echo "[pre-install] Removing any old reranker to force fresh download"
rm -f "$RERANKER_PATH"

echo "[pre-install] Downloading Xenova ms-marco-TinyBERT-L-2-v2 ONNX model (~82MB)..."
curl -L \
  --retry 3 \
  --retry-delay 5 \
  --progress-bar \
  "https://huggingface.co/ProTiger123/tinybert-reranker-seq128/resolve/main/model.onnx" \
  -o "$RERANKER_PATH"

FILE_SIZE=$(wc -c < "$RERANKER_PATH")
# Accept sizes >= 15 MB (actual Xenova model is ~17.6 MB)
if [ "$FILE_SIZE" -lt 15000000 ]; then
  echo "[pre-install] ❌ FATAL: reranker.onnx too small (${FILE_SIZE} bytes)"
  exit 1
fi
echo "[pre-install] ✅ Xenova TinyBERT reranker: ${FILE_SIZE} bytes"

echo "[pre-install] ✅ All model assets ready"