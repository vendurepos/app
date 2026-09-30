#!/usr/bin/env bash
# Tests for test-stack.sh: the real script runs in a temp copy of the package
# with fake docker, lsof and nc first on a PATH that holds nothing else it could
# reach, so no real container is ever touched. Run: bash scripts/test-stack.test.sh
set -uo pipefail
unset PLUGIN_TEST_PROJECT PLUGIN_TEST_PG_PORT PLUGIN_TEST_SMTP_PORT PLUGIN_TEST_MAILPIT_PORT \
  PLUGIN_TEST_SERVER_PORT PLUGIN_TEST_OFFSET
here=$(cd "$(dirname "$0")" && pwd)
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT

# bin/base: fake docker plus the few real tools the script uses. bin/lsof and
# bin/nc hold one fake each, so a case can leave either off PATH.
mkdir -p "$root/bin/base" "$root/bin/lsof" "$root/bin/nc"
for t in cksum cut dirname rm; do ln -s "$(command -v "$t")" "$root/bin/base/$t"; done
# Fake docker: `compose -p NAME ps -q|ps -aq|up -d --wait|down -v`, state in files.
cat > "$root/bin/base/docker" <<EOF
#!$BASH
s=\$STACK_FAKE_STATE p=\$3
echo "\$*" >> "\$s/docker.log"
case "\$4 \${5:-}" in
  "ps -q") [[ -e \$s/running/\$p ]] && echo "id-\$p" ;;
  "ps -aq") [[ -e \$s/running/\$p || -e \$s/stopped/\$p ]] && echo "id-\$p" ;;
  "up -d") : > "\$s/running/\$p" ;;
  "down -v") rm -f "\$s/running/\$p" "\$s/stopped/\$p" ;;
esac
exit 0
EOF
# Fake lsof: a port is listening when it is a line of lsof-busy.
cat > "$root/bin/lsof/lsof" <<EOF
#!$BASH
for a; do case \$a in -iTCP:*) port=\${a#-iTCP:} ;; esac; done
while read -r b; do [[ \$b == "\$port" ]] && exit 0; done < "\$STACK_FAKE_STATE/lsof-busy"
exit 1
EOF
# Fake nc: `nc -z HOST PORT` connects when "HOST PORT" is a line of nc-busy.
cat > "$root/bin/nc/nc" <<EOF
#!$BASH
while read -r b; do [[ \$b == "\$2 \$3" ]] && exit 0; done < "\$STACK_FAKE_STATE/nc-busy"
exit 1
EOF
chmod +x "$root"/bin/*/*

n=0
new_pkg() { # A fresh package copy (its own derived key) and fake state.
  n=$((n + 1)); PKG=$root/case$n/pkg; STATE=$root/case$n/state
  mkdir -p "$PKG/scripts" "$STATE/running" "$STATE/stopped"
  cp "$here/test-stack.sh" "$PKG/scripts/" && cp "$here/../docker-compose.yml" "$PKG/"
  : > "$STATE/lsof-busy"; : > "$STATE/nc-busy"; : > "$STATE/docker.log"
  LSOF=1 NC=1
}
run() { # run ACTION [VAR=value...]: stdout in $STATE/out, stderr in $STATE/err.
  local action=$1 path=$root/bin/base; shift
  (( LSOF )) && path+=":$root/bin/lsof"
  (( NC )) && path+=":$root/bin/nc"
  env PATH="$path" STACK_FAKE_STATE="$STATE" "$@" "$BASH" "$PKG/scripts/test-stack.sh" "$action" \
    > "$STATE/out" 2> "$STATE/err"
}
field() { sed -n "s/^$1=//p" "$2"; } # field KEY FILE
record() { printf '%s\n' "PLUGIN_TEST_PROJECT=$1" PLUGIN_TEST_PG_PORT=5460 \
  PLUGIN_TEST_SMTP_PORT=11060 PLUGIN_TEST_MAILPIT_PORT=18060 PLUGIN_TEST_SERVER_PORT=13060 \
  > "$PKG/.test-stack.env"; }

case_empty_env() {
  new_pkg; run env PLUGIN_TEST_PG_PORT= || return 1
  [[ $(field PLUGIN_TEST_PG_PORT "$STATE/out") =~ ^54[0-9][0-9]$ ]]
}
case_reuse() { # While the stack runs its ports are busy, so only reuse keeps them.
  new_pkg; run up || return 1
  cp "$PKG/.test-stack.env" "$STATE/first"
  field PLUGIN_TEST_PG_PORT "$STATE/first" >> "$STATE/lsof-busy"
  run up && cmp -s "$PKG/.test-stack.env" "$STATE/first"
}
refused() { # A recorded project `rec` in state $1 refuses `up` of another project.
  new_pkg; record rec; : > "$STATE/$1/rec"; cp "$PKG/.test-stack.env" "$STATE/before"
  ! run up PLUGIN_TEST_PROJECT=other && grep -q 'Test stack rec ' "$STATE/err" &&
    cmp -s "$PKG/.test-stack.env" "$STATE/before" && ! grep -q 'up -d' "$STATE/docker.log"
}
case_refuse_running() { refused running; }
case_refuse_stopped() { refused stopped; }
case_partial_record() {
  new_pkg; echo PLUGIN_TEST_PROJECT=vp-partial > "$PKG/.test-stack.env"
  run up || return 1
  [[ $(field PLUGIN_TEST_PROJECT "$PKG/.test-stack.env") == vp-partial ]] || return 1
  for k in PG SMTP MAILPIT SERVER; do
    [[ $(field "PLUGIN_TEST_${k}_PORT" "$PKG/.test-stack.env") =~ ^[0-9]+$ ]] || return 1
  done
}
case_busy_port() {
  new_pkg; run env || return 1
  local first; first=$(field PLUGIN_TEST_PG_PORT "$STATE/out"); echo "$first" >> "$STATE/lsof-busy"
  run env || return 1
  local second; second=$(field PLUGIN_TEST_PG_PORT "$STATE/out")
  [[ $second =~ ^54[0-9][0-9]$ && $second != "$first" ]]
}
case_reserved_5432() {
  new_pkg; run env PLUGIN_TEST_OFFSET=32 || return 1
  local pg; pg=$(field PLUGIN_TEST_PG_PORT "$STATE/out")
  [[ $pg =~ ^54[0-9][0-9]$ && $pg != 5432 ]]
}
case_nc_ipv6() { # nc answers only on ::1 for the derived PG port.
  new_pkg; run env || return 1
  local first; first=$(field PLUGIN_TEST_PG_PORT "$STATE/out"); echo "::1 $first" >> "$STATE/nc-busy"
  LSOF=0; run env || return 1
  local second; second=$(field PLUGIN_TEST_PG_PORT "$STATE/out")
  [[ $second =~ ^54[0-9][0-9]$ && $second != "$first" ]]
}
case_no_probe_tool() {
  new_pkg; LSOF=0 NC=0
  ! run env && grep -q 'needs lsof or nc' "$STATE/err"
}
case_down_uses_record() {
  new_pkg; record rec; : > "$STATE/running/rec"
  run down PLUGIN_TEST_PROJECT=other || return 1
  grep -qx 'compose -p rec down -v' "$STATE/docker.log" && ! grep -q other "$STATE/docker.log" &&
    [[ ! -e $PKG/.test-stack.env ]]
}

failed=0
for c in "empty env:case_empty_env" "the recorded stack is reused:case_reuse" \
  "a second project is refused (running):case_refuse_running" \
  "a second project is refused (stopped):case_refuse_stopped" \
  "a partial record:case_partial_record" "a busy port is skipped:case_busy_port" \
  "5432 is reserved:case_reserved_5432" "the nc fallback probes ::1:case_nc_ipv6" \
  "neither lsof nor nc:case_no_probe_tool" "down uses the record:case_down_uses_record"; do
  if "${c##*:}"; then echo "ok - ${c%:*}"; else echo "not ok - ${c%:*}"; failed=1; fi
done
exit "$failed"
