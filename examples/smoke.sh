#!/bin/sh
# Starts each example against the running compose stack (`make up`) and checks the four
# outcomes a caller can see. Run from the repo root: examples/smoke.sh
set -eu

export RIZ_API_URL="${RIZ_API_URL:-http://localhost:8080}"
export RIZ_WORKLOAD_TOKEN=dev-check-token
RIZ_APPLICATION=$(examples/seed.sh)
export RIZ_APPLICATION

pids=""
trap 'kill $pids 2>/dev/null || true' EXIT

expect() { # expect <status> <description> curl-args...
  want=$1 name=$2
  shift 2
  got=$(curl -s -o /dev/null -w '%{http_code}' "$@")
  [ "$got" = "$want" ] || { echo "FAIL $name: want $want, got $got"; exit 1; }
  echo "ok   $name"
}

smoke() { # smoke <name> <port>
  curl -sf --retry 30 --retry-all-errors --retry-delay 1 -o /dev/null \
    "http://localhost:$2/documents/d1" -H "authorization: Bearer dev-alice-token"
  expect 200 "$1: alice reads d1" "http://localhost:$2/documents/d1" -H "authorization: Bearer dev-alice-token"
  expect 403 "$1: alice denied d2" "http://localhost:$2/documents/d2" -H "authorization: Bearer dev-alice-token"
  expect 401 "$1: no token" "http://localhost:$2/documents/d1"
  expect 401 "$1: unknown token" "http://localhost:$2/documents/d1" -H "authorization: Bearer nobody"
}

uv run --frozen --project examples/fastapi uvicorn main:app --app-dir examples/fastapi --port 8101 &
pids="$!"
smoke fastapi 8101

pnpm --filter @riz/sdk build
PORT=8102 pnpm --filter @riz/example-express start &
pids="$pids $!"
smoke express 8102
