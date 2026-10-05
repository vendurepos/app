#!/usr/bin/env bash
# Checks the web export for the licence token, private keys and source maps.
# Never prints a match or the token.
# Usage: bash scripts/check-web-bundle.sh <dist>
set -euo pipefail
dist=${1:-}
if [[ ! -d "$dist" ]]; then
  echo "check-web-bundle: no export at $dist" >&2
  exit 2
fi
failed=0
if [[ -n ${RXDB_PREMIUM:-} ]]; then
  if grep -rqF -- "$RXDB_PREMIUM" "$dist"; then
    echo 'check-web-bundle: the RxDB Premium licence token is in the web export' >&2
    failed=1
  fi
else
  echo 'check-web-bundle: RXDB_PREMIUM not set; licence-token check skipped'
fi
if grep -rqE -- '-----BEGIN [A-Z ]*PRIVATE KEY-----' "$dist"; then
  echo 'check-web-bundle: a private key is in the web export' >&2
  failed=1
fi
if [[ -n $(find "$dist" -name '*.map' -print -quit) ]]; then
  echo 'check-web-bundle: source maps are in the web export' >&2
  failed=1
fi
if (( failed )); then exit 1; fi
echo 'check-web-bundle: ok'
exit 0
