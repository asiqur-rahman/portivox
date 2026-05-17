# Tunnelix MVP

This repository implements Phase 1 MVP from `tunnel_system_project_plan.md`.

## Current Status
- Gateway server implemented (`apps/gateway-server`)
- Tunnel client implemented (`apps/tunnel-client`)
- JSON-over-WebSocket request/response forwarding with stream IDs
- Dynamic subdomain assignment and in-memory registry
- Health and tunnel status endpoints: `/healthz`, `/api/tunnels`
- Heartbeat timeout handling, reconnect backoff, and body size limits

## Run (after npm install)
1. Install dependencies at root:
   `npm install`
2. Start gateway:
   `npm run dev:gateway`
3. Start client (for local app on port 3000):
   `npm run dev:client -- --gateway ws://localhost:7000/connect --local http://localhost:3000`
4. Open public endpoint via host header simulation:
   `curl -H "Host: abc.localtest.me" http://localhost:8080/`

## Notes
- Uses in-memory registry and no auth (MVP scope).
- In real deployment, place gateway behind Nginx/Caddy and wildcard DNS.

## Server Hardening Controls
- `MAX_REQUEST_BODY_BYTES` (default `1048576`)
- `TUNNEL_RESPONSE_TIMEOUT_MS` (default `20000`)
- `WS_IDLE_TIMEOUT_MS` (default `30000`)
- `LOCAL_REQUEST_TIMEOUT_MS` (default `15000`)
- `MAX_LOCAL_RESPONSE_BODY_BYTES` (default `2097152`)
- `AUTH_REQUIRED` (default `false`)
- `AUTH_API_KEYS` (comma-separated API keys, required when auth enabled)
- `AUTH_JWT_SECRET` (JWT secret for bearer-token validation)

## Auth Baseline (Sprint 2 start)
- Gateway WebSocket registration can require `x-api-key` when `AUTH_REQUIRED=true`.
- `GET /api/tunnels` and `/api/tunnels/*` require either:
  - valid `x-api-key`
  - or bearer JWT signed with `AUTH_JWT_SECRET`
- Management APIs now available:
  - `POST /api/tunnels` with JSON body `{ "subdomain": "your-name" }`
  - `GET /api/tunnels`
  - `DELETE /api/tunnels/:id`
  - `POST /api/keys` with JSON body `{ "name": "my-key" }` (JWT required)
  - `GET /api/keys`
  - `DELETE /api/keys/:id`

API key auth details:
- Static keys via `AUTH_API_KEYS` are still supported.
- Static key default scopes controlled by `AUTH_API_KEY_SCOPES`.
- Issued keys are stored as hashes and can authenticate tunnel management endpoints.
- Tunnel client can send API key header using `TUNNEL_API_KEY`.

Scope enforcement:
- `tunnel:create` for `POST /api/tunnels`
- `tunnel:read` for `GET /api/tunnels`
- `tunnel:delete` for `DELETE /api/tunnels/:id`
- `key:manage` for `/api/keys` endpoints

## Database Baseline (Prisma)
- Schema path: `prisma/schema.prisma`
- Generate Prisma client:
  - `npm run db:generate`

## Windows / Linux Tunnel Scripts

Windows:
- Start gateway: `npm run start:gateway:win`
- Start client: `npm run start:client:win`

Linux:
- Start gateway: `npm run start:gateway:linux`
- Start client: `npm run start:client:linux`

Optional env vars for scripts:
- `TUNNEL_GATEWAY_URL` (default `ws://localhost:7000/connect`)
- `TUNNEL_LOCAL_URL` (default `http://localhost:3000`)
- `TUNNEL_SUBDOMAIN` (optional)

## Docker

Build and run full stack:
- `docker compose up --build`

Services:
- `gateway` on host ports `8080` (HTTP) and `7000` (WS)
- `client` auto-connects to `ws://gateway:7000/connect`
- `sample-local-app` is an internal demo app on port `3000`

Test tunnel from host:
- `curl -H "Host: demo.localtest.me" http://localhost:8080/`

Expected response:
- `hello-from-docker-local-app`
