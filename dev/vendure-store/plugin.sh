#!/bin/bash
# Builds @vendurepos/plugin when its dist/ is missing or older than its sources, then installs this
# store's copy of it (.npmrc install-links: a copy, not a symlink) when that copy is missing or differs.
# reset.sh, start.sh and smoke.sh run it; the plugin must be built before this store's npm ci.
set -euo pipefail
cd "$(dirname "$0")"

plugin=../../packages/vendure-plugin
if [ ! -f "$plugin/dist/index.js" ] || [ -n "$(find "$plugin/src" "$plugin/package.json" "$plugin/tsconfig.json" \
    "$plugin/tsconfig.build.json" -newer "$plugin/dist/index.js" -print -quit)" ]; then
  echo "vendure-store: building @vendurepos/plugin"
  (cd "$plugin" && npm ci && npm run build)
fi
installed=node_modules/@vendurepos/plugin
if ! diff -rq "$plugin/dist" "$installed/dist" > /dev/null 2>&1 || ! cmp -s "$plugin/package.json" "$installed/package.json"; then
  echo "vendure-store: installing the built @vendurepos/plugin"
  npm ci
fi
