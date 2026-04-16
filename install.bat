@echo off
setlocal enabledelayedexpansion

pushd "%~dp0"

echo === HY-World 2.0 Playground Install ===

:: ---- Locate Python 3.10 ----
set PY_CMD=
py -3.10 --version >nul 2>nul && set PY_CMD=py -3.10
if "%PY_CMD%"=="" (
    where python3.10 >nul 2>nul && set PY_CMD=python3.10
)
if "%PY_CMD%"=="" (
    echo ERROR: Python 3.10 not found. Install it from python.org and re-run.
    exit /b 1
)
echo Using: %PY_CMD%

if not exist ".venv\Scripts\python.exe" (
    echo [1/6] Creating venv with Python 3.10...
    %PY_CMD% -m venv .venv
    if errorlevel 1 ( echo venv creation failed & exit /b 1 )
) else (
    echo [1/6] venv already exists - reusing.
)

set PIP=.venv\Scripts\pip.exe
set PYBIN=.venv\Scripts\python.exe

%PYBIN% -m pip install --upgrade pip wheel setuptools

echo [2/6] Installing PyTorch 2.4 + CUDA 12.4...
%PIP% install torch==2.4.0 torchvision==0.19.0 --index-url https://download.pytorch.org/whl/cu124
if errorlevel 1 ( echo torch install failed & exit /b 1 )

echo [3/6] Installing WorldMirror deps (Windows-patched)...
%PYBIN% scripts\patch_requirements_windows.py
%PIP% install -r requirements.windows.txt
if errorlevel 1 ( echo requirements install failed & exit /b 1 )

echo [4/6] Installing backend deps (FastAPI)...
%PIP% install -r app\backend\requirements.txt
if errorlevel 1 ( echo backend requirements install failed & exit /b 1 )

echo [5/6] Attempting FlashAttention-2 (skippable)...
%PIP% install flash-attn --no-build-isolation
if errorlevel 1 (
    echo WARNING: flash-attn install failed. Inference may use PyTorch SDPA fallback.
)

echo [6/6] Installing frontend deps...
pushd app\frontend
call npm install
if errorlevel 1 ( popd & echo frontend npm install failed & exit /b 1 )
popd

echo.
echo === Install complete. Run run.bat ===
endlocal
