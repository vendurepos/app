#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

export VENDURE_PORT="${VENDURE_PORT:-3000}" VENDURE_DB_PORT="${VENDURE_DB_PORT:-5442}" TZ=UTC

./plugin.sh
if [ "${KEEP_RUNNING:-}" != 1 ]; then
  trap ./stop.sh EXIT
fi
./reset.sh
./start.sh
npm run --silent smoke:check
