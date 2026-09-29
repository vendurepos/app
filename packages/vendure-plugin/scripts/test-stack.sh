#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

key=$(printf '%s' "$PWD" | cksum | cut -d' ' -f1)
offset=$(( key % 100 ))
PG_BASE=5400 # Start of the 100-port Postgres range.
PG_RESERVED=(5442 5443 5444 5445) # Dev store, smoke store, S1 and CI/legacy ports.
SMTP_BASE=11000 # Base for worktree SMTP ports.
MAILPIT_BASE=18000 # Base for worktree Mailpit API ports.
SERVER_BASE=13000 # Base for worktree Vendure test-server ports.
pg_port=$(( PG_BASE + offset ))
while [[ " ${PG_RESERVED[*]} " == *" $pg_port "* ]]; do
  pg_port=$(( PG_BASE + (pg_port - PG_BASE + 1) % 100 ))
done
export PLUGIN_TEST_PROJECT=${PLUGIN_TEST_PROJECT-vendurepos-plugin-${key}}
export PLUGIN_TEST_PG_PORT=${PLUGIN_TEST_PG_PORT-$pg_port}
export PLUGIN_TEST_SMTP_PORT=${PLUGIN_TEST_SMTP_PORT-$(( SMTP_BASE + offset ))}
export PLUGIN_TEST_MAILPIT_PORT=${PLUGIN_TEST_MAILPIT_PORT-$(( MAILPIT_BASE + offset ))}
export PLUGIN_TEST_SERVER_PORT=${PLUGIN_TEST_SERVER_PORT-$(( SERVER_BASE + offset ))}
stack_env=$(printf '%s\n' \
  "PLUGIN_TEST_PROJECT=$PLUGIN_TEST_PROJECT" \
  "PLUGIN_TEST_PG_PORT=$PLUGIN_TEST_PG_PORT" \
  "PLUGIN_TEST_SMTP_PORT=$PLUGIN_TEST_SMTP_PORT" \
  "PLUGIN_TEST_MAILPIT_PORT=$PLUGIN_TEST_MAILPIT_PORT" \
  "PLUGIN_TEST_SERVER_PORT=$PLUGIN_TEST_SERVER_PORT")

case "${1-}" in
  env) printf '%s\n' "$stack_env" ;;
  up)
    printf '%s\n' "$stack_env" > .test-stack.env
    docker compose -p "$PLUGIN_TEST_PROJECT" up -d --wait
    ;;
  down)
    docker compose -p "$PLUGIN_TEST_PROJECT" down -v
    rm -f .test-stack.env
    ;;
  *) echo "Usage: $0 up|down|env" >&2; exit 1 ;;
esac
