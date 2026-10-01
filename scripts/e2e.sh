#!/bin/bash
# pnpm e2e (plan VA6): the plugin packed and installed into a copy of the dev store as a tester would install it, a
# fresh vendurepos_e2e database, Vendure on :3100 and the web export on :8099 with its CSP as a response header; then
# the offline acceptance spec (VA7). Everything it starts is stopped and removed on exit, pass or fail.
set -euo pipefail
cd "$(dirname "$0")/.."

export VENDURE_PORT=3100 VENDURE_DB_NAME=vendurepos_e2e TZ=UTC
# Its own compose project and port: clear of the dev store (5442), smoke:web (5443) and the plugin's test stacks (5400-5499).
export COMPOSE_PROJECT_NAME=vendurepos-e2e VENDURE_DB_PORT=5501
# The store copy's plugin.sh leaves the installed tarball alone.
export VENDURE_PLUGIN_PACKED=1
WEB_PORT=8099

store=$(mktemp -d "${TMPDIR:-/tmp}/vendurepos-e2e.XXXXXX")
web_pid=
teardown() {
  local status=$?
  # The store is temporary, so its log goes with it: show the end of it on a failure.
  if [ "$status" != 0 ] && [ -f "$store/.run/vendure.log" ]; then
    tail -n 80 "$store/.run/vendure.log"
  fi
  if [ -n "$web_pid" ]; then
    kill "$web_pid" 2>/dev/null || true
  fi
  if [ -x "$store/stop.sh" ]; then
    "$store/stop.sh" || true
    (cd "$store" && docker compose down -v --remove-orphans) || true
  fi
  rm -rf "$store"
}
trap teardown EXIT

for port in "$VENDURE_PORT" "$WEB_PORT" "$VENDURE_DB_PORT"; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    echo "e2e: port $port is already in use" >&2
    exit 1
  fi
done

# The dev store's files, without its node_modules, so nothing resolves the workspace copy of the plugin.
cp -R dev/vendure-store/src dev/vendure-store/package.json dev/vendure-store/package-lock.json dev/vendure-store/tsconfig.json \
  dev/vendure-store/.npmrc dev/vendure-store/docker-compose.yml dev/vendure-store/*.sh "$store/"
(cd packages/vendure-plugin && npm ci --no-audit --no-fund && npm run build && npm pack --pack-destination "$store")
tarballs=("$store"/vendurepos-plugin-*.tgz)
(cd "$store" && npm install --no-audit --no-fund "${tarballs[0]}")

"$store/reset.sh"
"$store/start.sh"

# The export bundles rxdb-premium, whose build can print the licence token: filter the whole output.
# pipefail keeps a failed build failing; grep's own "nothing left" (status 1) is not a failure.
pnpm --filter @vendurepos/pos build:web 2>&1 | { grep -vi accesstoken || [ $? = 1 ]; }
node apps/pos/scripts/serve-web.ts apps/pos/dist "$WEB_PORT" &
web_pid=$!
for ((elapsed = 0; elapsed < 30; elapsed++)); do
  if curl -sf -o /dev/null "http://127.0.0.1:$WEB_PORT/"; then
    break
  fi
  sleep 1
done

(
  cd apps/pos
  E2E_STORE_URL="http://127.0.0.1:$VENDURE_PORT" E2E_WEB_SERVED=1 pnpm exec playwright test e2e/offline.spec.ts "$@"
)
