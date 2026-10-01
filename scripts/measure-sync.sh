#!/bin/bash
# Times a till's initial sync of the 2,000-product seed (PLAN §1: measured and reported, not a gate); docs/measurements.md.
set -euo pipefail
cd "$(dirname "$0")/.."

# Its own store, database, compose project and web port, clear of smoke:web (3200/5443/8099) and pnpm e2e (3100/5501/8099).
export VENDURE_PORT=3400 VENDURE_DB_PORT=5530 COMPOSE_PROJECT_NAME=vendurepos-measure VENDURE_SEED=large
export E2E_WEB_PORT=8199

# Even on failure: stop Vendure, drop the measurement database and stop the web server if Playwright left it behind.
cleanup() {
  dev/vendure-store/stop.sh || true
  (cd dev/vendure-store && docker compose down -v) || true
  local pids
  pids=$(lsof -ti "tcp:$E2E_WEB_PORT" -sTCP:LISTEN || true)
  if [ -n "$pids" ]; then kill $pids || true; fi
}
trap cleanup EXIT

dev/vendure-store/plugin.sh
dev/vendure-store/reset.sh
dev/vendure-store/start.sh

# The export bundles rxdb-premium, whose build can print the licence token: filter the whole output.
pnpm --filter @vendurepos/pos build:web 2>&1 | { grep -vi accesstoken || [ $? = 1 ]; }
(
  cd apps/pos
  # Each repeat is a new test with a fresh browser context, so an empty local database.
  E2E_STORE_URL="http://127.0.0.1:$VENDURE_PORT" MEASURE_SYNC=1 \
    pnpm exec playwright test e2e/measure-sync.spec.ts --repeat-each=3 "$@"
)
