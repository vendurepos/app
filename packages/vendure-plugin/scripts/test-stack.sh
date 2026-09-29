#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

key=$(printf '%s' "$PWD" | cksum | cut -d' ' -f1)
offset=$(( key % 100 ))
offset=${PLUGIN_TEST_OFFSET:-$offset} # Test hook for exercising a specific starting offset.
PG_BASE=5400 # Start of the 100-port Postgres range.
PG_RESERVED=(5432 5442 5443 5444 5445) # Host Homebrew Postgres, dev store, smoke store, S1 and CI/legacy.
SMTP_BASE=11000 # Base for worktree SMTP ports.
MAILPIT_BASE=18000 # Base for worktree Mailpit API ports.
SERVER_BASE=13000 # Base for worktree Vendure test-server ports.
port_free() { ! lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

reuse=0
if [[ -f .test-stack.env ]]; then
  while IFS='=' read -r k v; do
    case "$k" in
      PLUGIN_TEST_PROJECT|PLUGIN_TEST_PG_PORT|PLUGIN_TEST_SMTP_PORT|PLUGIN_TEST_MAILPIT_PORT|PLUGIN_TEST_SERVER_PORT)
        printf -v "recorded_$k" '%s' "$v" ;;
    esac
  done < .test-stack.env
  reuse=1
fi
export PLUGIN_TEST_PROJECT=${PLUGIN_TEST_PROJECT:-${recorded_PLUGIN_TEST_PROJECT:-vendurepos-plugin-${key}}}
if [[ "${1:-}" == up && $reuse == 1 ]] &&
   [[ -z $(docker compose -p "$PLUGIN_TEST_PROJECT" ps -q) ]]; then
  for k in PG SMTP MAILPIT SERVER; do
    v=recorded_PLUGIN_TEST_${k}_PORT
    if ! port_free "${!v}"; then reuse=0; break; fi
  done
fi
if [[ "${1:-}" != down && $reuse == 0 ]]; then
  unset recorded_PLUGIN_TEST_{PG,SMTP,MAILPIT,SERVER}_PORT
  for ((i=0; i<100; i++)); do
    o=$(( (offset + i) % 100 ))
    [[ " ${PG_RESERVED[*]} " != *" $((PG_BASE + o)) "* ]] || continue
    if port_free "$((PG_BASE + o))" && port_free "$((SMTP_BASE + o))" &&
       port_free "$((MAILPIT_BASE + o))" && port_free "$((SERVER_BASE + o))"; then
      offset=$o; break
    fi
  done
  if (( i == 100 )); then
    echo "No free test-stack ports in 5400-5499, 11000-11099, 18000-18099 and 13000-13099." >&2
    exit 1
  fi
fi
export PLUGIN_TEST_PG_PORT=${PLUGIN_TEST_PG_PORT:-${recorded_PLUGIN_TEST_PG_PORT:-$(( PG_BASE + offset ))}}
export PLUGIN_TEST_SMTP_PORT=${PLUGIN_TEST_SMTP_PORT:-${recorded_PLUGIN_TEST_SMTP_PORT:-$(( SMTP_BASE + offset ))}}
export PLUGIN_TEST_MAILPIT_PORT=${PLUGIN_TEST_MAILPIT_PORT:-${recorded_PLUGIN_TEST_MAILPIT_PORT:-$(( MAILPIT_BASE + offset ))}}
export PLUGIN_TEST_SERVER_PORT=${PLUGIN_TEST_SERVER_PORT:-${recorded_PLUGIN_TEST_SERVER_PORT:-$(( SERVER_BASE + offset ))}}
stack_env=$(printf '%s\n' \
  "PLUGIN_TEST_PROJECT=$PLUGIN_TEST_PROJECT" \
  "PLUGIN_TEST_PG_PORT=$PLUGIN_TEST_PG_PORT" \
  "PLUGIN_TEST_SMTP_PORT=$PLUGIN_TEST_SMTP_PORT" \
  "PLUGIN_TEST_MAILPIT_PORT=$PLUGIN_TEST_MAILPIT_PORT" \
  "PLUGIN_TEST_SERVER_PORT=$PLUGIN_TEST_SERVER_PORT")

case "${1:-}" in
  env) printf '%s\n' "$stack_env" ;;
  up)
    printf '%s\n' "$stack_env" > .test-stack.env
    docker compose -p "$PLUGIN_TEST_PROJECT" up -d --wait
    ;;
  down)
    docker compose -p "${recorded_PLUGIN_TEST_PROJECT:-$PLUGIN_TEST_PROJECT}" down -v
    rm -f .test-stack.env
    ;;
  *) echo "Usage: $0 up|down|env" >&2; exit 1 ;;
esac
