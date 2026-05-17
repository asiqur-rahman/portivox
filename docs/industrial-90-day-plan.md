# Tunnelix 90-Day Execution Plan (World-Class / Industrial Track)

## Baseline (Current)
- Working Phase-1 style MVP exists:
  - Gateway HTTP ingress + WS tunnel plane
  - Tunnel client with reconnect + heartbeat
  - Subdomain routing + basic hardening
  - Windows/Linux scripts + Dockerized stack
- Gaps:
  - No real auth/tenant control
  - No distributed registry
  - JSON protocol only, limited streaming guarantees
  - Limited observability and operations model

---

## 90-Day Objective
By Day 90, ship **v1 Industrial Beta** with:
1. Multi-instance capable control/data plane
2. Production auth (users, API keys, RBAC-lite)
3. Reliable stream handling with measurable SLOs
4. Enterprise-ready observability, auditability, and operational controls

---

## Delivery Principles
- Keep backwards-compatible behavior during migration.
- Ship every 2 weeks with production-like validation.
- Feature flags for risky protocol/control-plane changes.
- Every new capability must include telemetry + runbook notes.

---

## Team Assumption (minimum)
- 1 Backend lead (gateway/protocol)
- 1 Full-stack engineer (API/admin)
- 1 Platform/DevOps engineer (infra/CI/CD/observability)
- 1 QA/SRE shared role (test automation + reliability drills)

---

## Sprint Plan (2-week sprints)

## Sprint 1 (Days 1-14): Production Foundation

### Goals
- Stabilize repo architecture and environments.
- Define SLOs and production constraints.

### Deliverables
- Monorepo conventions finalized (`apps`, `packages`, `infrastructure`, `docs`).
- Env spec and config matrix per service (`dev/stage/prod`).
- CI baseline:
  - lint
  - typecheck
  - unit tests
  - Docker image build
- Initial SLO draft:
  - Gateway availability target
  - p95 tunnel round-trip latency target
  - reconnect success target

### Technical Work
- Add strict runtime config validation package.
- Add centralized error model and structured logging contract.
- Add minimal smoke/integration harness for gateway+client in CI.

### Exit Criteria
- Green CI on every PR.
- Reproducible local + Docker + stage startup.

---

## Sprint 2 (Days 15-28): Auth + Identity Core

### Goals
- Introduce secure access model.

### Deliverables
- Auth service/API modules:
  - user registration/login (or SSO-ready abstraction)
  - JWT issuance/validation
  - API key generation + revoke
- Tunnel ownership model.
- Protected tunnel-management APIs.

### Technical Work
- PostgreSQL + Prisma schema:
  - users
  - api_keys
  - tunnels
  - tunnel_sessions
  - audit_events
- Gateway middleware for token/API key validation.
- Per-key scopes (`tunnel:create`, `tunnel:read`, `tunnel:delete`).

### Exit Criteria
- Unauthorized tunnel registration blocked.
- Every tunnel mapped to owner identity.
- Audit logs for key lifecycle events.

---

## Sprint 3 (Days 29-42): Distributed Registry + Multi-Gateway

### Goals
- Remove single-node bottleneck.

### Deliverables
- Redis-backed tunnel registry.
- Heartbeat-based session liveness across instances.
- Multi-gateway deployment blueprint.

### Technical Work
- Registry abstraction:
  - in-memory adapter (dev)
  - Redis adapter (stage/prod)
- Lease/TTL model for tunnel session ownership.
- Conflict resolution on reconnect/subdomain reuse.
- Basic sticky-session guidance for ingress.

### Exit Criteria
- 2+ gateway instances serve active tunnels.
- Client reconnect survives one gateway instance restart.

---

## Sprint 4 (Days 43-56): Protocol Reliability Upgrade

### Goals
- Industrialize stream handling.

### Deliverables
- Protocol v2 design doc and implementation path.
- Backpressure-aware streaming pipeline.
- Better multiplexing controls and limits.

### Technical Work
- Introduce framed message envelope:
  - protocol version
  - stream id
  - message type
  - optional chunk metadata
- Add per-stream/state machine on both gateway/client.
- Add configurable limits:
  - max concurrent streams per tunnel
  - max frame size
  - max in-flight bytes
- Add timeout classes:
  - connect timeout
  - response timeout
  - idle stream timeout

### Exit Criteria
- Load test with sustained concurrent streams without memory growth trend.
- No stream-leak on forced disconnect scenarios.

---

## Sprint 5 (Days 57-70): Observability + Ops Excellence

### Goals
- Make system operable at scale.

### Deliverables
- Metrics and dashboards.
- Alerting and runbooks.
- Traceability across ingress -> tunnel -> local target.

### Technical Work
- OpenTelemetry integration.
- Prometheus metrics:
  - active tunnels
  - stream open/close rate
  - error rate by type
  - reconnect attempts
  - p50/p95/p99 tunnel request latency
- Grafana dashboard pack.
- Alert thresholds and incident SOP docs.

### Exit Criteria
- On-call can detect and triage tunnel outage with dashboard + logs only.
- SLO burn-rate alert configured.

---

## Sprint 6 (Days 71-84): Enterprise Controls + Security Hardening

### Goals
- Add professional controls expected by enterprises.

### Deliverables
- RBAC-lite (Owner/Admin/Viewer roles per workspace).
- Rate limiting and abuse protection.
- Domain and policy controls.

### Technical Work
- Workspace/team model + membership.
- Rate limits per API key and per tunnel.
- Request policy engine (IP allowlist baseline).
- Certificate/domain management abstraction (for future wildcard/custom domains).

### Exit Criteria
- Tenant isolation validated.
- Abuse tests trigger limits and safe degradation behavior.

---

## Sprint 7 (Days 85-90): Industrial Beta Hardening + Launch Readiness

### Goals
- Ship with confidence.

### Deliverables
- Release candidate build.
- Reliability game days.
- Security checklist and deployment playbook.

### Technical Work
- Failure drills:
  - gateway crash
  - Redis outage simulation
  - DB latency spike
  - reconnect storm
- Performance benchmark report and capacity numbers.
- Finalized docs:
  - architecture
  - runbooks
  - security posture
  - upgrade/migration notes

### Exit Criteria
- Industrial Beta tag released.
- Go/No-Go checklist signed.

---

## Architecture Evolution (Target by Day 90)

```text
Internet
  -> Edge (Nginx/Caddy/Cloud LB)
  -> Gateway Cluster (stateless)
  -> Redis (registry + coordination)
  -> PostgreSQL (identity, ownership, audit)
  -> Metrics/Logs/Traces stack
```

Client side:
```text
Local Service <-> Tunnel Client Agent <-> Gateway Cluster
```

---

## KPI Targets (Day 90)
- Gateway uptime (stage/prod): >= 99.9%
- Median tunnel request latency overhead: <= 40ms (in-region baseline)
- Reconnect success after transient loss (30s window): >= 99%
- Unauthenticated tunnel registration success rate: 0%
- MTTR for common incidents: < 30 minutes

---

## Risks and Mitigations
- Protocol rewrite risk:
  - Mitigate with protocol v1/v2 dual support window.
- Redis dependency risk:
  - Mitigate with circuit-breaking and degraded-mode safeguards.
- Scope overrun risk:
  - Mitigate with strict sprint exit criteria and feature flags.
- Security regressions:
  - Mitigate with threat model review each sprint + dependency scanning.

---

## Immediate Next 10-Day Task Breakdown
1. Implement config validation package + env schema.
2. Add Postgres/Prisma foundation and initial migrations.
3. Add JWT/API key middleware into gateway registration path.
4. Build `POST /api/tunnels`, `GET /api/tunnels`, `DELETE /api/tunnels/:id` (auth-protected).
5. Add integration tests for auth + tunnel ownership path.
6. Add CI pipeline with build/test/docker stages.

---

## Definition of Done (applies to every major feature)
- Unit tests + integration tests exist.
- Structured logs and metrics are emitted.
- Security implications documented.
- Rollback strategy documented.
- Runbook updated.
