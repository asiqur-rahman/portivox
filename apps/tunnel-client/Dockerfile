FROM node:22-alpine AS base
WORKDIR /app

# ── deps: install packages only ─────────────────────────────────────────────
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
RUN npm ci --fetch-retries=5 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=120000 \
  || (echo "npm ci failed, retrying..." && sleep 5 && npm ci --fetch-retries=5 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=120000)

# ── builder: compile ─────────────────────────────────────────────────────────
FROM deps AS builder
COPY . .
RUN npm run -w apps/tunnel-client build

# ── runner: lean production image ────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV TUNNEL_GATEWAY_URL=ws://gateway:7000/connect
ENV TUNNEL_LOCAL_URL=http://sample-local-app:3000
ENV LOCAL_REQUEST_TIMEOUT_MS=15000
ENV MAX_LOCAL_RESPONSE_BODY_BYTES=2097152

COPY --from=builder /app/node_modules                        ./node_modules
COPY --from=builder /app/apps/tunnel-client/dist             ./apps/tunnel-client/dist
COPY --from=builder /app/apps/tunnel-client/package.json     ./apps/tunnel-client/package.json
COPY --from=builder /app/packages                            ./packages
COPY --from=builder /app/package.json                        ./package.json

CMD ["node", "apps/tunnel-client/dist/index.js"]
