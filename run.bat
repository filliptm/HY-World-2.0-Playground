@echo off
setlocal enabledelayedexpansion

pushd "%~dp0"

set BACKEND_PORT=8000
set FRONTEND_PORT=5173

echo === Killing processes on ports %BACKEND_PORT% and %FRONTEND_PORT% ===
for %%P in (%BACKEND_PORT% %FRONTEND_PORT%) do (
    for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%%P " ^| findstr "LISTENING"') do (
        echo   killing PID %%a on port %%P
        taskkill /F /PID %%a >nul 2>nul
    )
)

if not exist ".venv\Scripts\activate.bat" (
    echo ERROR: venv not found. Run install.bat first.
    exit /b 1
)
if not exist "app\frontend\node_modules" (
    echo ERROR: frontend node_modules missing. Run install.bat first.
    exit /b 1
)

echo.
echo === Launching backend on :%BACKEND_PORT% ===
start "hy-world backend" cmd /k "call .venv\Scripts\activate.bat && set TORCH_CUDA_ARCH_LIST=9.0+PTX && cd app\backend && python -m uvicorn main:app --host 0.0.0.0 --port %BACKEND_PORT%"

echo === Launching frontend on :%FRONTEND_PORT% ===
start "hy-world frontend" cmd /k "cd app\frontend && npm run dev"

echo.
echo Backend:  http://localhost:%BACKEND_PORT%/api/health
echo Frontend: http://localhost:%FRONTEND_PORT%
echo.
echo Close the spawned terminal windows to stop.
endlocal
