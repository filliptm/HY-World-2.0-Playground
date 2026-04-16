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
    echo [1/8] Creating venv with Python 3.10...
    %PY_CMD% -m venv .venv
    if errorlevel 1 ( echo venv creation failed & exit /b 1 )
) else (
    echo [1/8] venv already exists - reusing.
)

set PIP=.venv\Scripts\pip.exe
set PYBIN=.venv\Scripts\python.exe

%PYBIN% -m pip install --upgrade pip wheel setuptools

echo [2/8] Installing PyTorch 2.7 + CUDA 12.8 (Blackwell/Hopper/Ada/Ampere/Turing support)...
%PIP% install torch==2.7.0 torchvision==0.22.0 torchaudio==2.7.0 --index-url https://download.pytorch.org/whl/cu128
if errorlevel 1 ( echo torch install failed & exit /b 1 )

echo [3/8] Installing WorldMirror deps (Windows-patched)...
%PYBIN% scripts\patch_requirements_windows.py
%PIP% install -r requirements.windows.txt
if errorlevel 1 ( echo requirements install failed & exit /b 1 )

echo [4/8] Installing backend deps (FastAPI)...
%PIP% install -r app\backend\requirements.txt
if errorlevel 1 ( echo backend requirements install failed & exit /b 1 )

echo [5/8] Detecting GPU...
%PYBIN% scripts\setup_gpu.py --write
if errorlevel 1 ( echo GPU detection failed & exit /b 1 )
set /p CUDA_ARCH=<.cuda_arch
echo   --^> TORCH_CUDA_ARCH_LIST=%CUDA_ARCH%

echo [6/8] Pre-compiling gsplat CUDA kernels for your GPU (first time only; can take 2-10 minutes)...
call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" >nul 2>nul
if errorlevel 1 (
    echo WARNING: VS 2022 vcvars64 not found. gsplat compile will fail if MSVC isn't on PATH.
)
set "CUDA_HOME=C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.6"
if not exist "%CUDA_HOME%\bin\nvcc.exe" (
    for /d %%v in ("C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.*") do set "CUDA_HOME=%%v"
)
set "CUDA_PATH=%CUDA_HOME%"
set "PATH=%CUDA_HOME%\bin;%PATH%"
set "DISTUTILS_USE_SDK=1"
set "TORCH_CUDA_ARCH_LIST=%CUDA_ARCH%"
%PYBIN% -c "from gsplat.cuda._backend import _C; print('gsplat ready')"
if errorlevel 1 (
    echo WARNING: gsplat pre-compile failed. It will retry on first inference.
)

echo [7/8] Attempting FlashAttention-2 (skippable - SDPA fallback covers bf16)...
%PIP% install flash-attn --no-build-isolation 2>nul
if errorlevel 1 (
    echo   -^> flash-attn not available; will use PyTorch SDPA fallback.
)

echo [8/8] Installing frontend deps...
pushd app\frontend
call npm install
if errorlevel 1 ( popd & echo frontend npm install failed & exit /b 1 )
popd

echo.
echo === Install complete. Run run.bat ===
endlocal
