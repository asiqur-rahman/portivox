#!/bin/sh
# Gateway entrypoint — waits for the database, applies migrations, then starts.
# "prisma migrate deploy" is idempotent; retries cover MySQL/Postgres still booting.
set -e

if [ -n "$DATABASE_URL" ]; then
  _provider="${DB_PROVIDER:-mysql}"
  echo "[gateway] Running database migrations (DB_PROVIDER=${_provider})..."
  i=1
  while [ "$i" -le 45 ]; do
    if node /app/node_modules/.bin/prisma migrate deploy \
      --schema "/app/prisma/${_provider}/schema.prisma"; then
      echo "[gateway] Migrations complete."
      break
    fi
    echo "[gateway] Database not ready (attempt ${i}/45), retrying in 2s..."
    i=$((i + 1))
    sleep 2
  done
  if [ "$i" -gt 45 ]; then
    echo "[gateway] Migrations failed after 45 attempts." >&2
    exit 1
  fi
fi

exec node apps/gateway-server/dist/index.js
