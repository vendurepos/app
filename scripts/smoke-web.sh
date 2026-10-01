#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

export VENDURE_PORT="${VENDURE_PORT:-3200}"
# Its own compose project and port, so the reset never touches another checkout's dev database.
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-vendurepos-smoke}"
export VENDURE_DB_PORT="${VENDURE_DB_PORT:-5443}"

# Builds @vendurepos/plugin first, then runs the dev store's npm ci when its copy of the plugin is missing or stale.
dev/vendure-store/plugin.sh

trap dev/vendure-store/stop.sh EXIT
dev/vendure-store/reset.sh
dev/vendure-store/start.sh
# A POS sale through POST /tally/v1/commands, its replay and a malformed batch, before Playwright.
(cd dev/vendure-store && npm run --silent smoke:check)

# The export bundles rxdb-premium, whose build can print the licence token: filter the whole output.
# pipefail keeps a failed build failing; grep's own "nothing left" (status 1) is not a failure.
pnpm --filter @vendurepos/pos build:web 2>&1 | { grep -vi accesstoken || [ $? = 1 ]; }
(
  cd apps/pos
  # e2e/offline.spec.ts is pnpm e2e's (scripts/e2e.sh), on its own store.
  E2E_STORE_URL="http://127.0.0.1:$VENDURE_PORT" pnpm exec playwright test e2e/sign-in.spec.ts "$@"
)
