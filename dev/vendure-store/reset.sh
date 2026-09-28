#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

export VENDURE_PORT="${VENDURE_PORT:-3000}" VENDURE_DB_PORT="${VENDURE_DB_PORT:-5442}" TZ=UTC

./stop.sh
docker compose down -v
docker compose up -d --wait postgres
npm run --silent seed
echo "vendure-store: reset and seeded; run ./start.sh"
