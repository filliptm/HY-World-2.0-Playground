#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

BACKEND_PORT=8000
FRONTEND_PORT=5173

kill_port() {
  local port="$1"
  if [ "$OS" = "Windows_NT" ]; then
    # Windows via git-bash: use netstat + taskkill
    local pids
    pids=$(netstat -ano 2>/dev/null | awk -v p=":$port " '$0 ~ p && /LISTENING/ {print $5}' | sort -u)
    for pid in $pids; do
      echo "  killing PID $pid on port $port"
      taskkill //F //PID "$pid" >/dev/null 2>&1 || true
    done
  else
    if command -v lsof >/dev/null 2>&1; then
      local pids
      pids=$(lsof -ti:"$port" || true)
      for pid in $pids; do
        echo "  killing PID $pid on port $port"
        kill -9 "$pid" 2>/dev/null || true
      done
    elif command -v fuser >/dev/null 2>&1; then
      fuser -k "$port/tcp" 2>/dev/null || true
    fi
  fi
}

echo "=== Killing processes on ports $BACKEND_PORT and $FRONTEND_PORT ==="
kill_port "$BACKEND_PORT"
kill_port "$FRONTEND_PORT"

if [ ! -d ".venv" ]; then
  echo "ERROR: venv not found. Run ./install.sh first."; exit 1
fi
if [ ! -d "app/frontend/node_modules" ]; then
  echo "ERROR: frontend node_modules missing. Run ./install.sh first."; exit 1
fi

if [ -f ".venv/Scripts/activate" ]; then
  # shellcheck disable=SC1091
  source .venv/Scripts/activate
else
  # shellcheck disable=SC1091
  source .venv/bin/activate
fi

cleanup() {
  echo
  echo "=== Stopping ==="
  [ -n "${BACKEND_PID:-}" ] && kill "$BACKEND_PID" 2>/dev/null || true
  [ -n "${FRONTEND_PID:-}" ] && kill "$FRONTEND_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "=== Launching backend on :$BACKEND_PORT ==="
export TORCH_CUDA_ARCH_LIST="9.0+PTX"
( cd app/backend && python -m uvicorn main:app --host 0.0.0.0 --port "$BACKEND_PORT" ) &
BACKEND_PID=$!

echo "=== Launching frontend on :$FRONTEND_PORT ==="
( cd app/frontend && npm run dev ) &
FRONTEND_PID=$!

echo
echo "Backend:  http://localhost:$BACKEND_PORT/api/health"
echo "Frontend: http://localhost:$FRONTEND_PORT"
echo
echo "Ctrl+C to stop both."

wait
