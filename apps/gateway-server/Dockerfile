FROM node:22-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package*.json ./
COPY apps ./apps
COPY packages ./packages
RUN npm ci

FROM deps AS builder
COPY . .
RUN npm run -w apps/gateway-server build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV GATEWAY_PORT=8080
ENV GATEWAY_WS_PORT=7000
ENV ROOT_DOMAIN=portivox.braintechsolution.com
ENV MAX_REQUEST_BODY_BYTES=1048576
ENV TUNNEL_RESPONSE_TIMEOUT_MS=20000
ENV WS_IDLE_TIMEOUT_MS=30000

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/gateway-server ./apps/gateway-server
COPY --from=builder /app/apps/gateway-server/dist ./apps/gateway-server/dist
COPY --from=builder /app/apps/gateway-server/package.json ./apps/gateway-server/package.json
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/package.json ./package.json

EXPOSE 8080 7000
CMD ["node", "apps/gateway-server/dist/index.js"]

