#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

export VENDURE_PORT="${VENDURE_PORT:-3000}" VENDURE_DB_PORT="${VENDURE_DB_PORT:-5442}" TZ=UTC

if [ -f .run/vendure.pid ]; then
  pid=$(cat .run/vendure.pid)
  if kill -0 "$pid" 2>/dev/null; then
    echo "vendure-store: already running (pid $pid)"
    exit 0
  fi
fi

if (exec 3<>/dev/tcp/127.0.0.1/$VENDURE_PORT) 2>/dev/null; then
  echo "vendure-store: port $VENDURE_PORT is already in use; set VENDURE_PORT" >&2
  exit 1
fi

./plugin.sh
docker compose up -d --wait postgres
if [ -z "$(docker compose exec -T postgres psql -U vendure -d vendure -tAc "select to_regclass('public.channel')")" ]; then
  echo "vendure-store: database is empty; run ./reset.sh first" >&2
  exit 1
fi

mkdir -p .run
nohup node --import tsx src/index.ts > .run/vendure.log 2>&1 &
pid=$!
echo "$pid" > .run/vendure.pid

for ((elapsed = 0; elapsed < 90; elapsed++)); do
  if ! kill -0 "$pid" 2>/dev/null; then
    break
  fi
  if curl -sf -X POST "http://127.0.0.1:$VENDURE_PORT/shop-api" -H 'content-type: application/json' --data '{"query":"{ __typename }"}' > /dev/null; then
    echo "vendure-store: Admin API http://127.0.0.1:$VENDURE_PORT/admin-api"
    echo "vendure-store: Shop API http://127.0.0.1:$VENDURE_PORT/shop-api"
    echo "vendure-store: log $(pwd)/.run/vendure.log (pid $pid)"
    exit 0
  fi
  sleep 1
done

echo "vendure-store: server exited or did not become ready within 90 seconds" >&2
tail -n 40 .run/vendure.log
rm -f .run/vendure.pid
if kill -0 "$pid" 2>/dev/null; then
  kill -TERM "$pid"
fi
exit 1
