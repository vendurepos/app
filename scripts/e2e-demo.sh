#!/bin/bash
# pnpm e2e:demo (plan VA9): the demo build (EXPO_PUBLIC_VENDUREPOS_DEMO=1) served on its own port, 8098, with its CSP
# as a response header, and e2e/demo.spec.ts against it. No Vendure store runs: the demo answers in the page. The web
# server is stopped on exit, pass or fail.
set -euo pipefail
cd "$(dirname "$0")/.."

# Clear of pnpm e2e (8099) and measure:sync (8199).
WEB_PORT=8098

web_pid=
teardown() {
  if [ -n "$web_pid" ]; then
    kill "$web_pid" 2>/dev/null || true
  fi
}
trap teardown EXIT

if (exec 3<>"/dev/tcp/127.0.0.1/$WEB_PORT") 2>/dev/null; then
  echo "e2e:demo: port $WEB_PORT is already in use" >&2
  exit 1
fi

# The export bundles rxdb-premium, whose build can print the licence token: filter the whole output.
# pipefail keeps a failed build failing; grep's own "nothing left" (status 1) is not a failure.
pnpm --filter @vendurepos/pos build:web:demo 2>&1 | { grep -vi accesstoken || [ $? = 1 ]; }
# The export is what a host publishes, so no secret may be in it (#82 item 8).
bash scripts/check-web-bundle.sh apps/pos/dist
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
  E2E_DEMO=1 E2E_WEB_SERVED=1 E2E_WEB_PORT="$WEB_PORT" pnpm exec playwright test "$@"
)
