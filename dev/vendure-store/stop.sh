#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

if [ -f .run/vendure.pid ]; then
  pid=$(cat .run/vendure.pid)
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid"
    echo "vendure-store: sent TERM to pid $pid"
    for ((elapsed = 0; elapsed < 20; elapsed++)); do
      if ! kill -0 "$pid" 2>/dev/null; then
        break
      fi
      sleep 1
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid"
      echo "vendure-store: sent KILL to pid $pid"
    fi
  else
    echo "vendure-store: pid $pid was not running"
  fi
else
  echo "vendure-store: server was not running"
fi
rm -f .run/vendure.pid

docker compose stop
echo "vendure-store: stopped (database volume retained)"
