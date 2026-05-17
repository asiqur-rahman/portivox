FROM node:22-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package*.json ./
COPY apps ./apps
COPY packages ./packages
RUN npm ci

FROM deps AS builder
COPY . .
RUN npm run -w apps/tunnel-client build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV TUNNEL_GATEWAY_URL=ws://gateway:7000/connect
ENV TUNNEL_LOCAL_URL=http://sample-local-app:3000
ENV LOCAL_REQUEST_TIMEOUT_MS=15000
ENV MAX_LOCAL_RESPONSE_BODY_BYTES=2097152

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/tunnel-client/node_modules ./apps/tunnel-client/node_modules
COPY --from=builder /app/apps/tunnel-client/dist ./apps/tunnel-client/dist
COPY --from=builder /app/apps/tunnel-client/package.json ./apps/tunnel-client/package.json
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/package.json ./package.json

CMD ["node", "apps/tunnel-client/dist/index.js"]
