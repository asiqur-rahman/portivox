#!/bin/sh
# Gateway entrypoint — runs DB migrations (if DATABASE_URL is set) then starts the server.
# Running "prisma migrate deploy" on every start is safe: it is idempotent and fast
# when all migrations are already applied.
set -e

if [ -n "$DATABASE_URL" ]; then
  echo "[gateway] Running database migrations (DB_PROVIDER=${DB_PROVIDER:-postgresql})..."
  node /app/node_modules/.bin/prisma migrate deploy \
    --schema "/app/prisma/${DB_PROVIDER:-postgresql}/schema.prisma" \
    && echo "[gateway] Migrations complete."
fi

exec node apps/gateway-server/dist/index.js
