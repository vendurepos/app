#!/bin/bash
# pnpm e2e:hosted (#55, plan VA8): e2e/demo.spec.ts against a hosted demo build, by default demo.vendurepos.com,
# so its CSP gate and its check of the SQLite worker's wasm policy run against the host's real response headers
# (apps/pos/vercel.json). Nothing is built or served locally. E2E_BASE_URL picks another host.
set -euo pipefail
cd "$(dirname "$0")/.."

(
  cd apps/pos
  E2E_DEMO=1 E2E_BASE_URL="${E2E_BASE_URL:-https://demo.vendurepos.com}" pnpm exec playwright test "$@"
)
