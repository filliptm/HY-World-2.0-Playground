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
  echo "[1/6] Creating venv with Python 3.10..."
  $PY -m venv .venv
else
  echo "[1/6] venv already exists — reusing."
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

echo "[2/6] Installing PyTorch 2.4 + CUDA 12.4..."
$PIP install torch==2.4.0 torchvision==0.19.0 --index-url https://download.pytorch.org/whl/cu124

echo "[3/6] Installing WorldMirror deps..."
if [ "$OS" = "Windows_NT" ]; then
  $PYBIN scripts/patch_requirements_windows.py
  $PIP install -r requirements.windows.txt
else
  $PIP install -r requirements.txt
fi

echo "[4/6] Installing backend deps (FastAPI)..."
$PIP install -r app/backend/requirements.txt

echo "[5/6] Attempting FlashAttention-2 (skippable)..."
$PIP install flash-attn --no-build-isolation || \
  echo "  WARNING: flash-attn install failed. Inference may run with PyTorch SDPA fallback."

echo "[6/6] Installing frontend deps..."
(cd app/frontend && npm install)

echo
echo "=== Install complete. Run ./run.sh ==="
