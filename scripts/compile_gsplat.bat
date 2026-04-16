@echo off
:: Compile gsplat CUDA kernels for Blackwell (sm_120)
:: Uses: CUDA 12.6 toolkit + MSVC 2022 + TORCH_CUDA_ARCH_LIST with PTX fallback

setlocal

pushd "%~dp0\.."

call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 (
    echo ERROR: vcvars64 activation failed
    exit /b 1
)

set "CUDA_HOME=C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.6"
set "CUDA_PATH=%CUDA_HOME%"
set "PATH=%CUDA_HOME%\bin;%PATH%"

:: Target Blackwell directly (12.0) and 9.0 with PTX for forward compat
set "TORCH_CUDA_ARCH_LIST=9.0+PTX"
set "DISTUTILS_USE_SDK=1"

echo Using:
echo   CUDA_HOME = %CUDA_HOME%
echo   TORCH_CUDA_ARCH_LIST = %TORCH_CUDA_ARCH_LIST%
nvcc --version | findstr release
cl 2>&1 | findstr Microsoft

echo.
echo Compiling gsplat kernels (this can take 10-20 minutes)...
call .venv\Scripts\activate.bat
python -c "import os; print('arch list:', os.environ.get('TORCH_CUDA_ARCH_LIST'));from gsplat.cuda._backend import _C; print('gsplat backend loaded OK:', _C)"
set EC=%errorlevel%
popd
endlocal & exit /b %EC%
