#!/usr/bin/env bash
# shellcheck disable=SC2329  # the case_* functions are run by name below
# Tests the real bundle checker against temporary exports without printing findings.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
export RXDB_PREMIUM=test-token-123
mkdir "$root/clean" "$root/token" "$root/key" "$root/map"
printf '%s\n' '<html></html>' > "$root/clean/index.html"
printf '%s\n' 'var k="test-token-123";' > "$root/token/bundle.js"
printf '%s\n' '-----BEGIN PRIVATE KEY-----' > "$root/key/key.pem"
: > "$root/map/app.js.map"

case_clean() {
  bash "$here/check-web-bundle.sh" "$root/clean" > "$root/out" 2>&1
}
case_token() {
  local status=0
  bash "$here/check-web-bundle.sh" "$root/token" > "$root/out" 2>&1 || status=$?
  [[ $status == 1 ]] && grep -q 'licence token' "$root/out" &&
    ! grep -qF 'test-token-123' "$root/out"
}
case_skipped() {
  env -u RXDB_PREMIUM bash "$here/check-web-bundle.sh" "$root/token" > "$root/out" 2>&1 &&
    grep -q 'licence-token check skipped' "$root/out"
}
case_key() {
  local status=0
  bash "$here/check-web-bundle.sh" "$root/key" > "$root/out" 2>&1 || status=$?
  [[ $status == 1 ]] && grep -q 'private key' "$root/out"
}
case_map() {
  local status=0
  bash "$here/check-web-bundle.sh" "$root/map" > "$root/out" 2>&1 || status=$?
  [[ $status == 1 ]] && grep -q 'source maps' "$root/out"
}
case_missing() {
  local status=0
  bash "$here/check-web-bundle.sh" "$root/missing" > "$root/out" 2>&1 || status=$?
  [[ $status == 2 ]]
}

failed=0
for c in 'clean export passes:case_clean' 'token found, never printed:case_token' \
  'token check skipped without the variable:case_skipped' 'private key found:case_key' \
  'source map found:case_map' 'missing export:case_missing'; do
  if "${c##*:}"; then echo "ok - ${c%:*}"; else echo "not ok - ${c%:*}"; failed=1; fi
done
exit "$failed"
