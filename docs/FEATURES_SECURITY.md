# Portivox Features & Security Overview

This document summarizes what is implemented in this project today, with focus on production-relevant features and security controls.

## Implemented Core Features

### 1) Tunnel Modes
- **HTTP tunneling** over persistent WebSocket client-gateway channel.
- **Raw TCP tunneling** (`--tcp`) for SSH/RDP/database-style connections.
- Tunnel registration supports requested subdomain allocation.
- Client auto-reconnect with backoff.
- Heartbeat-based liveness and idle timeout handling.

### 2) Gateway Runtime
- Fastify-based gateway with:
  - HTTP ingress routing by subdomain.
  - WebSocket control plane (`/connect`) for tunnel clients.
- In-memory or Redis-backed tunnel registry.
- Optional multi-node lease coordination with Redis.
- OpenAPI export and API compatibility checks.

### 3) Client Experience (Openport-style UX)
- `portivox register <apiKey>` to save key locally.
- `portivox open <port>` for HTTP exposure.
- `portivox open <port> --tcp` for raw TCP exposure.
- Interactive launcher command:
  - `portivox` menu for register/open/gateway/client actions.
- Local client config persisted at:
  - Windows: `%USERPROFILE%\\.portivox\\client.json`
  - Linux/macOS: `~/.portivox/client.json`

### 4) Dockerization
- Dockerfiles for gateway and client.
- `docker-compose.yml` for gateway + redis + sample app + client.
- Docker smoke test automation script implemented.

### 5) Test Coverage (Implemented)
- HTTP smoke test.
- TCP smoke test.
- Docker smoke test script (designed for CI runners with Docker).
- Contract/integration test scripts for:
  - Auth
  - API contracts
  - Rate limiting
  - Security/CORS
  - Payload validation
  - Idempotency
  - Audit replay/query
  - SDK integration

### 6) CI/CD
- GitHub Actions workflow updated to `portivox-ci`.
- Pipeline runs build + integration/contract tests.
- Separate Docker smoke job validates containerized behavior.

---

## Security Features Implemented

### A) Authentication & Authorization
- Supports API-key and JWT-based principal resolution.
- Scope-aware authorization checks for API operations.
- Role handling (`owner`, `admin`, `viewer`) in API flows.
- Unauthorized WebSocket and HTTP access are rejected.

### B) API Security Headers
When enabled, gateway returns hardened headers including:
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: no-referrer`
- `X-XSS-Protection: 0`
- Restrictive `Content-Security-Policy`

### C) CORS Controls
- Configurable allowlist (`CORS_ALLOWED_ORIGINS`).
- Optional credentials support.
- Explicit preflight handling for API routes.

### D) Rate Limiting
- Separate rate limiters for:
  - API read operations
  - API write operations
  - API admin operations
  - Tunnel ingress traffic
- Returns rate-limit headers and `429` on overuse.

### E) Input & Payload Validation
- Structured body parsing and allowlisted request keys.
- Validation for critical admin and tunnel creation payloads.
- Request body size limits (`MAX_REQUEST_BODY_BYTES`).

### F) Idempotency Protection
- Configurable idempotency support for API write operations.
- TTL-based replay cache to prevent accidental duplicate mutations.

### G) Tunnel Stream Safety
- Stream idle timeout enforcement.
- Max concurrent streams per tunnel.
- Chunked response reassembly with timeout cleanup.
- Graceful error conversion for disconnected tunnel sessions.

### H) Registry Lease Safety
- Lease token model for subdomain ownership in registry backend.
- Heartbeat refresh + lease expiry behavior.
- Subdomain release on socket disconnect.

### I) Auditability
- Audit store events for auth and tunnel actions.
- JSONL export support.
- Webhook export with retry and dead-letter options.
- Query API for audit event retrieval.

### J) Operational Controls
- Readiness and health endpoints (`/readyz`, `/healthz`).
- Maintenance mode and drain mode controls.
- Startup grace and runtime toggles via env config.

---

## TCP Security Notes (Current)

- TCP mode forwards raw bytes end-to-end; application-layer auth/encryption is handled by the tunneled protocol itself (for example SSH/TLS/RDP).
- Public TCP ports are allocated from configured ranges.
- Access control to create TCP tunnels is still enforced at gateway auth layer (API key/JWT).
- For production:
  - use strict API key/JWT management,
  - restrict exposed port ranges at firewall level,
  - prefer TLS-protected protocols through the tunnel.

---

## Production Hardening Checklist (Recommended)

- Enable `AUTH_REQUIRED=true`.
- Use strong `AUTH_JWT_SECRET` and rotate API keys.
- Restrict CORS allowlist to trusted origins only.
- Keep `SECURITY_HEADERS_ENABLED=true`.
- Set realistic ingress/API rate limits for your traffic profile.
- Use Redis registry for multi-instance deployments.
- Configure audit webhook + dead-letter for compliance visibility.
- Restrict `TCP_PUBLIC_PORT_START/END` with host firewall/security groups.
- Run gateway behind TLS termination and monitored reverse proxy.

---

## Current Scope vs Next Enterprise Steps

Implemented now:
- HTTP + TCP tunnel core, auth, rate-limit, audit, CI, Docker, smoke tests.

Strong next steps:
- End-to-end TLS/mTLS options for control plane.
- Per-tunnel policy engine (allowed destinations, protocol restrictions).
- Tenant isolation quotas and billing-grade metering.
- Session recording/forensics options for regulated environments.
- Managed installer to register and run client as system service automatically.
