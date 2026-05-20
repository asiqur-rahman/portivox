# ── Stage 1: build frontend SPA ──────────────────────────────
FROM node:22-alpine AS frontend-builder
WORKDIR /app

# Copy only package manifests first — source changes won't bust this layer.
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
RUN npm ci

COPY . .
RUN npm run -w apps/frontend build

# ── Stage 2: nginx runner ─────────────────────────────────────
FROM nginx:1.27-alpine AS runner

# envsubst is included in the official nginx:alpine image.
COPY infra/nginx/nginx.conf.template /etc/nginx/nginx.conf.template
COPY infra/nginx/entrypoint.sh       /entrypoint.sh
RUN chmod +x /entrypoint.sh

COPY --from=frontend-builder /app/apps/frontend/dist /usr/share/nginx/html

EXPOSE 80
ENTRYPOINT ["/entrypoint.sh"]
