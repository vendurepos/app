#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

export VENDURE_PORT="${VENDURE_PORT:-3200}"
# Its own compose project and port, so the reset never touches another checkout's dev database.
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-vendurepos-smoke}"
export VENDURE_DB_PORT="${VENDURE_DB_PORT:-5443}"

if [ ! -d dev/vendure-store/node_modules ]; then
  (cd dev/vendure-store && npm ci)
fi

trap dev/vendure-store/stop.sh EXIT
dev/vendure-store/reset.sh
dev/vendure-store/start.sh

pnpm --filter @vendurepos/pos build:web
(
  cd apps/pos
  E2E_STORE_URL="http://127.0.0.1:$VENDURE_PORT" pnpm exec playwright test "$@"
)
