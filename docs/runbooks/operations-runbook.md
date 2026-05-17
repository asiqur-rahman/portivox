# Portivox Operations Runbook

## 1. Pre-Deploy Checklist
- Confirm CI is green (`build`, `test:smoke`, `test:chunk`, `test:auth`)
- Confirm DB migration state is current (`npm run db:migrate:deploy`)
- Confirm `/readyz` returns `200` on active nodes
- Confirm `/metrics` is scrapeable
- Confirm Redis is reachable when `REGISTRY_BACKEND=redis`

## 2. Safe Deploy Procedure
1. Set drain mode on target node:
   `POST /api/admin/state { "draining": true }`
2. Wait until active requests settle (monitor `gateway_active_tunnels` and request rate)
3. Deploy/restart node
4. Wait for startup grace and `readyz=200`
5. Re-enable serving:
   `POST /api/admin/state { "draining": false, "maintenanceMode": false }`

## 3. Incident Triage Basics
- If `/healthz` fails: process-level outage, restart service
- If `/healthz` ok but `/readyz` fails: node is draining/maintenance/unready
- If auth APIs fail with 401/403: verify API keys/JWT scopes/roles
- If ingress 429 spikes: check rate limits and client retry behavior
- If tunnel 504 spikes: inspect client connectivity and `TUNNEL_STREAM_IDLE_TIMEOUT` counters

## 4. Recovery Actions
- Toggle maintenance mode for emergency stop:
  `POST /api/admin/state { "maintenanceMode": true }`
- Resume traffic:
  `POST /api/admin/state { "maintenanceMode": false, "draining": false }`
- Restart tunnel client agents if websocket churn is high

## 5. Post-Incident Notes Template
- Incident start/end time
- Blast radius
- Root cause
- Detection signal (metric/log)
- Mitigation steps
- Follow-up tasks

