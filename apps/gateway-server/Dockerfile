FROM node:22-alpine AS base
WORKDIR /app

# ── deps: install packages only ─────────────────────────────────────────────
# Copy only package manifests first so source changes don't bust this layer.
FROM base AS deps
COPY package*.json ./
COPY apps/gateway-server/package.json ./apps/gateway-server/
COPY apps/tunnel-client/package.json   ./apps/tunnel-client/
COPY apps/frontend/package.json        ./apps/frontend/
COPY packages/auth/package.json            ./packages/auth/
COPY packages/config/package.json          ./packages/config/
COPY packages/errors/package.json          ./packages/errors/
COPY packages/logger/package.json          ./packages/logger/
COPY packages/protocol/package.json        ./packages/protocol/
COPY packages/sdk/package.json             ./packages/sdk/
COPY packages/portivox-client/package.json ./packages/portivox-client/
RUN npm ci || (echo "npm ci failed, retrying..." && sleep 5 && npm ci)

# ── builder: compile ─────────────────────────────────────────────────────────
FROM deps AS builder
COPY . .
ARG DB_PROVIDER=mysql
ENV DB_PROVIDER=${DB_PROVIDER}
RUN npm run db:generate
RUN npm run -w apps/gateway-server build

# ── runner: lean production image ────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# All other environment variables are supplied by docker-compose / the runtime.

COPY --from=builder /app/node_modules                             ./node_modules
# npm may not hoist all packages to root; copy workspace-local node_modules too
COPY --from=deps    /app/apps/gateway-server/node_modules         ./apps/gateway-server/node_modules
COPY --from=builder /app/apps/gateway-server/dist                 ./apps/gateway-server/dist
COPY --from=builder /app/apps/gateway-server/package.json         ./apps/gateway-server/package.json
COPY --from=builder /app/packages                                 ./packages
COPY --from=builder /app/package.json                             ./package.json
# Prisma schema needed by the entrypoint migration step
COPY --from=builder /app/prisma                                   ./prisma

# Drop privileges: run as the built-in non-root `node` user so a container
# escape has a smaller blast radius. chown so the process can read/generate.
RUN chown -R node:node /app

COPY apps/gateway-server/docker-entrypoint.sh /entrypoint.sh
RUN apk add --no-cache wget \
  && sed -i 's/\r$//' /entrypoint.sh \
  && chmod +x /entrypoint.sh

USER node

EXPOSE 8080 7000

# Image-level liveness probe so bare `docker run` / orchestrators without a
# compose healthcheck still know when the gateway is up.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

ENTRYPOINT ["/entrypoint.sh"]
