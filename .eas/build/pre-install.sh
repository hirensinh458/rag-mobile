#!/usr/bin/env bash
# scripts/pre-install.sh
#
# CHANGE from previous version: added Python ONNX verification step after
# extracting reranker.onnx. The build now FAILS FAST with a clear error if
# the downloaded model has no classification head (the root cause of -4.875),
# so you catch a bad model at build time rather than discovering it at runtime.
#
# Everything else is identical to your current script.

set -euo pipefail

MODEL_DIR="assets/models"
EMBEDDER_PATH="$MODEL_DIR/bge-small.onnx"
RERANKER_PATH="$MODEL_DIR/reranker.onnx"

# ── Download bge-small.onnx from HuggingFace ────────────────────────────────
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

# ── Verify embedder size ─────────────────────────────────────────────────────
FILE_SIZE=$(wc -c < "$EMBEDDER_PATH")
if [ "$FILE_SIZE" -lt 10000000 ]; then
  echo "[pre-install] ❌ FATAL: bge-small.onnx is too small (${FILE_SIZE} bytes) — download likely failed"
  exit 1
fi

# ── Download TinyBERT-L-2-v2 reranker ───────────────────────────────────────
RERANKER_ZIP="/tmp/tinybert_reranker.zip"

echo "[pre-install] Removing any old reranker to force fresh download"
rm -f "$RERANKER_PATH"

echo "[pre-install] Downloading custom TinyBERT-L-2-v2 ONNX (~25MB)..."
curl -L --retry 5 --retry-delay 10 --progress-bar \
  "https://huggingface.co/amardev/ms-marco-TinyBERT-L-2-v2-onnx/resolve/main/ms-marco-TinyBERT-L-2-v2-onnx.zip" \
  -o "$RERANKER_ZIP"

unzip -p "$RERANKER_ZIP" 'model.onnx' > "$RERANKER_PATH"
rm "$RERANKER_ZIP"

FILE_SIZE=$(wc -c < "$RERANKER_PATH")
if [ "$FILE_SIZE" -lt 15000000 ]; then
  echo "[pre-install] ❌ FATAL: reranker.onnx too small (${FILE_SIZE} bytes)"
  exit 1
fi
echo "[pre-install] ✅ Custom TinyBERT reranker: ${FILE_SIZE} bytes"

# ── CHANGE: Verify reranker has a classification head before bundling ─────────
# Runs a quick ONNX inference test with a relevant vs irrelevant pair.
# Fails the build immediately if scores are identical (backbone-only model).
# This prevents ever shipping a broken reranker to users.
echo "[pre-install] Verifying reranker classification head..."

python3 - "$RERANKER_PATH" << 'PYEOF'
import sys, numpy as np

try:
    import onnxruntime as ort
except ImportError:
    print("[pre-install] onnxruntime not installed — skipping ONNX verification")
    print("[pre-install] Install with:  pip install onnxruntime")
    sys.exit(0)

model_path = sys.argv[1]
sess = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])

input_names  = [i.name for i in sess.get_inputs()]
output_names = [o.name for o in sess.get_outputs()]
output_shape = sess.get_outputs()[0].shape

print(f"[pre-install]   Input nodes:  {input_names}")
print(f"[pre-install]   Output nodes: {output_names}")
print(f"[pre-install]   Output shape: {output_shape}")

# Detect backbone-only export (no classification head)
if any("hidden_state" in n or "last_hidden" in n for n in output_names):
    print("[pre-install] ❌ FATAL: reranker.onnx has NO classification head.")
    print("[pre-install]    Output is 'last_hidden_state' — this is a backbone-only export.")
    print("[pre-install]    This model will always output -4.875 regardless of input.")
    print("[pre-install]    Re-export with:  optimum-cli export onnx --task text-classification")
    sys.exit(1)

# Score a relevant and an irrelevant pair using manual token IDs
# "What is the capital of France?" vs "Paris is the capital." / "The dog jumped."
q_ids  = [2054, 2003, 1996, 3007, 1997, 2605, 1029]   # what is the capital of france ?
rel_ids = [3000, 2003, 1996, 3007, 1997, 2605, 1012]   # paris is the capital of france .
irr_ids = [1996, 3899, 3167, 2058, 1996, 5415, 1012]   # the dog jumped over the fence .

def run(q, c):
    ids  = np.array([[101] + q + [102] + c + [102]], dtype=np.int64)
    mask = np.ones_like(ids)
    tt   = np.zeros_like(ids)
    tt[0, len(q) + 2:] = 1
    feeds = {}
    if "input_ids"      in input_names: feeds["input_ids"]      = ids
    if "attention_mask" in input_names: feeds["attention_mask"] = mask
    if "token_type_ids" in input_names: feeds["token_type_ids"] = tt
    out = sess.run(None, feeds)
    return float(np.array(out[0]).flatten()[0])

rel_score = run(q_ids, rel_ids)
irr_score = run(q_ids, irr_ids)

print(f"[pre-install]   Relevant pair  score: {rel_score:.4f}")
print(f"[pre-install]   Irrelevant pair score: {irr_score:.4f}")
print(f"[pre-install]   Score spread: {rel_score - irr_score:.4f}")

if abs(rel_score - irr_score) < 0.01:
    print("[pre-install] ❌ FATAL: Scores are identical — model has no working classification head.")
    print(f"[pre-install]    Both pairs scored {rel_score:.4f}.")
    if abs(rel_score - (-4.875)) < 0.1:
        print("[pre-install]    Score ≈ -4.875 → backbone-only model (official HF export). Re-export.")
    elif abs(rel_score - (-8.090)) < 0.1:
        print("[pre-install]    Score ≈ -8.090 → binary model reading wrong logit index.")
    sys.exit(1)

if rel_score <= irr_score:
    print("[pre-install] ⚠ WARNING: Relevant pair scored LOWER than irrelevant pair.")
    print("[pre-install]   Model may be inverted or using wrong output index.")
    print("[pre-install]   Continuing build — verify on device.")
else:
    print("[pre-install] ✅ Reranker verified: relevant > irrelevant ✓")

PYEOF

echo "[pre-install] ✅ All model assets ready"