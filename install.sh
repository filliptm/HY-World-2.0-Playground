#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

echo "=== HY-World 2.0 Playground Install ==="

# ---- Python 3.10 ----
PY=""
if command -v py >/dev/null 2>&1 && py -3.10 --version >/dev/null 2>&1; then
  PY="py -3.10"
elif command -v python3.10 >/dev/null 2>&1; then
  PY="python3.10"
else
  echo "ERROR: Python 3.10 not found. Install it first."
  exit 1
fi

if [ ! -d ".venv" ]; then
  echo "[1/8] Creating venv with Python 3.10..."
  $PY -m venv .venv
else
  echo "[1/8] venv already exists — reusing."
fi

# Activate (Windows git-bash uses Scripts, Unix uses bin)
if [ -f ".venv/Scripts/activate" ]; then
  # shellcheck disable=SC1091
  source .venv/Scripts/activate
  PIP=".venv/Scripts/pip.exe"
  PYBIN=".venv/Scripts/python.exe"
else
  # shellcheck disable=SC1091
  source .venv/bin/activate
  PIP=".venv/bin/pip"
  PYBIN=".venv/bin/python"
fi

$PYBIN -m pip install --upgrade pip wheel setuptools

echo "[2/8] Installing PyTorch 2.7 + CUDA 12.8 (Blackwell/Hopper/Ada/Ampere/Turing support)..."
$PIP install torch==2.7.0 torchvision==0.22.0 torchaudio==2.7.0 --index-url https://download.pytorch.org/whl/cu128

echo "[3/8] Installing WorldMirror deps..."
if [ "$OS" = "Windows_NT" ]; then
  $PYBIN scripts/patch_requirements_windows.py
  $PIP install -r requirements.windows.txt
else
  $PIP install -r requirements.txt
fi

echo "[4/8] Installing backend deps (FastAPI)..."
$PIP install -r app/backend/requirements.txt

echo "[5/8] Detecting GPU..."
$PYBIN scripts/setup_gpu.py --write
CUDA_ARCH=$(cat .cuda_arch)
echo "  → TORCH_CUDA_ARCH_LIST=$CUDA_ARCH"

echo "[6/8] Pre-compiling gsplat CUDA kernels for your GPU (first time only; can take 2-10 minutes)..."
export TORCH_CUDA_ARCH_LIST="$CUDA_ARCH"
if $PYBIN -c "from gsplat.cuda._backend import _C; print('gsplat ready')"; then
  echo "  → gsplat compiled OK"
else
  echo "  WARNING: gsplat pre-compile failed. It will retry on first inference."
fi

echo "[7/8] Attempting FlashAttention-2 (skippable — SDPA fallback covers bf16)..."
$PIP install flash-attn --no-build-isolation 2>/dev/null || \
  echo "  → flash-attn not available; will use PyTorch SDPA fallback."

echo "[8/8] Installing frontend deps..."
(cd app/frontend && npm install)

echo
echo "=== Install complete. Run ./run.sh ==="
