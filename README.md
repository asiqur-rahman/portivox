# Tunnelix MVP

This repository implements Phase 1 MVP from `tunnel_system_project_plan.md`.

## Current Status
- Gateway server implemented (`apps/gateway-server`)
- Tunnel client implemented (`apps/tunnel-client`)
- JSON-over-WebSocket request/response forwarding with stream IDs
- Dynamic subdomain assignment and in-memory registry
- Health and tunnel status endpoints: `/healthz`, `/api/tunnels`
- Metrics endpoint: `/metrics` (Prometheus text format)
- Readiness endpoint: `/readyz`
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
- `RESPONSE_CHUNK_BYTES` (default `0`, disabled; set >0 to split large tunneled responses into protocol chunks)
- `AUTH_REQUIRED` (default `false`)
- `AUTH_API_KEYS` (comma-separated API keys, required when auth enabled)
- `AUTH_JWT_SECRET` (JWT secret for bearer-token validation)
- `AUDIT_EXPORT_JSONL_PATH` (optional absolute/relative path for JSONL audit export)
- `AUDIT_EXPORT_WEBHOOK_URL` (optional HTTP endpoint to receive audit events)
- `AUDIT_EXPORT_WEBHOOK_TIMEOUT_MS` (default `3000`)
- `AUDIT_EXPORT_WEBHOOK_SECRET` (optional shared secret for `x-tunnelix-signature`)
- `AUDIT_EXPORT_WEBHOOK_MAX_RETRIES` (default `3`)
- `AUDIT_EXPORT_WEBHOOK_RETRY_BASE_MS` (default `250`, exponential backoff)
- `AUDIT_EXPORT_DEAD_LETTER_JSONL_PATH` (optional failed webhook event sink)
- `API_VERSION` (default `1`, returned as `x-api-version` on `/api/*`)
- `API_DEPRECATION_ENABLED` (default `false`, enables `Deprecation`/`Sunset` headers on `/api/*`)
- `API_SUNSET_DATE` (optional HTTP-date for `Sunset` header, used when deprecation enabled)
- `API_RATE_LIMIT_READ_PER_MIN` (default `600`)
- `API_RATE_LIMIT_WRITE_PER_MIN` (default `300`)
- `API_RATE_LIMIT_ADMIN_PER_MIN` (default `120`)
- `INGRESS_RATE_LIMIT_PER_MIN` (default `1200`)
- `CORS_ALLOWED_ORIGINS` (comma-separated origins for `/api/*`; empty allows `*`)
- `CORS_ALLOW_CREDENTIALS` (default `false`)
- `SECURITY_HEADERS_ENABLED` (default `true`)
- `IDEMPOTENCY_ENABLED` (default `true`)
- `IDEMPOTENCY_TTL_MS` (default `300000`)

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
- JWT roles supported: `owner`, `admin`, `viewer`
- `/api/keys` endpoints require role `owner` or `admin` in addition to scope

Registry backend:
- `REGISTRY_BACKEND=memory|redis` (default `memory`)
- `REDIS_URL` required when using redis backend
- `REDIS_KEY_PREFIX` default `tunnelix:registry`
- `REGISTRY_LEASE_TTL_MS` default `30000`
- `MAX_CONCURRENT_STREAMS_PER_TUNNEL` default `200`
- `STREAM_IDLE_TIMEOUT_MS` default `15000`

Observability:
- Gateway exports Prometheus-compatible metrics at `/metrics`
- Tunnel forwarding adds `x-tunnel-request-id` for request correlation
- Chunk diagnostics metrics:
  - `gateway_chunk_frames_total`
  - `gateway_chunk_reassembled_streams_total`
  - `gateway_chunk_incomplete_timeouts_total`

Protocol chunking:
- When `RESPONSE_CHUNK_BYTES > 0`, tunnel client can emit multi-frame `http_response` messages using `meta.chunk`.
- Gateway reassembles chunks by `streamId` and returns a single HTTP response to the caller.

OpenAPI:
- Gateway serves OpenAPI JSON at `/openapi.json`.
- Example: `curl http://localhost:8080/openapi.json`
- Swagger UI is available at `/docs` and JSON at `/docs/json`.
- Export versioned OpenAPI artifact:
  - `npm run openapi:export` (writes `docs/openapi.v1.json`)
- Validate SDK/OpenAPI version compatibility:
  - `npm run openapi:check-sdk-compat`
- API contract validation:
  - `npm run test:api-contract`
  - `npm run test:rate-limit-contract`
  - `npm run test:security-cors-contract`
  - `npm run test:payload-validation-contract`
  - `npm run test:idempotency-contract`
- Lifecycle policy:
  - `docs/runbooks/api-lifecycle-policy.md`

Enterprise baseline controls:
- API management endpoints have per-principal rate limiting (in-memory)
- Public tunnel ingress has per-subdomain rate limiting (in-memory)

Operational controls:
- `MAINTENANCE_MODE` (default `false`)
- `STARTUP_GRACE_MS` (default `0`)
- Admin runtime state control endpoint:
  - `POST /api/admin/state` with body `{ "maintenanceMode": true|false, "draining": true|false }`
  - `GET /api/admin/chunk-diagnostics` for chunk reassembly counters and active assemblies

Audit export:
- Security/runtime audit events can be exported to:
  - JSONL file sink (`AUDIT_EXPORT_JSONL_PATH`)
  - webhook sink (`AUDIT_EXPORT_WEBHOOK_URL`)
- Webhook delivery supports:
  - signature header `x-tunnelix-signature: sha256=<hex>`
  - retry with exponential backoff
  - dead-letter JSONL fallback for failed deliveries
- Dead-letter replay tooling:
  - Dry run: `npm run audit:replay-dead-letter -- --dry-run --input ./dead-letter.jsonl`
  - Replay + compact delivered records:
    - `npm run audit:replay-dead-letter -- --input ./dead-letter.jsonl --compact-on-success`
  - Replay with report file:
    - `npm run audit:replay-dead-letter -- --input ./dead-letter.jsonl --report-path ./reports/audit-replay.json`
  - Replay requests include `x-tunnelix-idempotency-key` per record for safer downstream dedupe.

Runbook and drills:
- Operations runbook: `docs/runbooks/operations-runbook.md`
- Release checklist: `docs/runbooks/release-checklist.md`
- Readiness/metrics drill: `npm run drill:health`
- Drain cycle drill (requires admin token/key):
  - `ADMIN_BEARER_TOKEN=<token> npm run drill:drain`

Distributed validation:
- Run Redis-backed coordination test:
  - `REDIS_URL=redis://localhost:6379 npm run test:redis-registry`
- Optional multi-gateway compose profile:
  - `docker compose --profile scale up --build`

## Database Baseline (Prisma)
- Schema path: `prisma/schema.prisma`
- Generate Prisma client:
  - `npm run db:generate`

## SDK (Node.js / TypeScript)

Package:
- `packages/sdk` (`tunnelix-sdk`)

Example:
- `const { TunnelixClient } = require("tunnelix-sdk");`
- `const client = new TunnelixClient({ baseUrl: "http://localhost:8080", apiKey: process.env.TUNNEL_API_KEY });`
- `await client.listTunnels();`
- SDK integration test:
  - `npm run test:sdk`

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
