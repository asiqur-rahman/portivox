# Tunnel System Project Plan (OpenPort/ngrok-style)

## Project Goal

Build a self-hosted reverse tunneling platform similar to:
- OpenPort
- ngrok
- Cloudflare Tunnel
- FRP

Primary use-case:
Expose localhost services to the public internet through a secure reverse tunnel.

---

# 1. Final System Architecture

```text
┌───────────────────────────┐
│  User Local Machine       │
│                           │
│ localhost:3000            │
│ localhost:8080            │
└────────────┬──────────────┘
             │
             │ HTTP Proxy
             ▼
┌───────────────────────────┐
│ Tunnel Client Agent       │
│                           │
│ Persistent WebSocket      │
│ Reconnect Logic           │
│ Heartbeat                 │
│ Local Forwarding          │
└────────────┬──────────────┘
             │
             │ WSS/TLS
             ▼
┌───────────────────────────┐
│ Public Tunnel Gateway     │
│                           │
│ Subdomain Router          │
│ Tunnel Registry           │
│ Request Multiplexer       │
│ Auth Validation           │
└────────────┬──────────────┘
             │
             ▼
┌───────────────────────────┐
│ Internet Users            │
│                           │
│ abc.yourdomain.com        │
└───────────────────────────┘
```

---

# 2. Recommended Tech Stack

## Backend Runtime
- Node.js (LTS)

## Framework
- Fastify

## WebSocket
- ws

## Reverse Proxy
- node-http-proxy

## TLS Termination
- Caddy OR Nginx

## Database
- PostgreSQL

## Cache / Session Store
- Redis

## ORM
- Prisma

## Auth
- JWT

## DevOps
- Docker
- Docker Compose

---

# 3. Recommended Repository Structure

```text
tunnel-platform/
│
├── apps/
│   ├── gateway-server/
│   ├── tunnel-client/
│   ├── dashboard-api/
│   └── admin-panel/
│
├── packages/
│   ├── protocol/
│   ├── shared-types/
│   ├── auth/
│   ├── logger/
│   └── config/
│
├── infrastructure/
│   ├── docker/
│   ├── nginx/
│   ├── caddy/
│   ├── kubernetes/
│   └── terraform/
│
├── docs/
│
├── scripts/
│
├── docker-compose.yml
├── package.json
├── turbo.json
└── README.md
```

---

# 4. Development Phases

# PHASE 1 — Basic Tunnel MVP

Goal:
Expose localhost:3000 publicly.

Features:
- Single tunnel
- One client
- WebSocket connection
- HTTP forwarding
- No auth
- No database

Duration:
1-2 weeks

Success Criteria:
```bash
localhost:3000
↓
https://abc.example.com
```

---

# PHASE 2 — Multi-Tunnel Support

Features:
- Multiple clients
- Tunnel registry
- Dynamic subdomains
- Tunnel cleanup
- Heartbeats
- Auto reconnect

Duration:
1 week

---

# PHASE 3 — Authentication

Features:
- User accounts
- JWT auth
- API keys
- Tunnel ownership
- Protected APIs

Duration:
1 week

---

# PHASE 4 — Dashboard

Features:
- Tunnel list
- Tunnel status
- Logs
- Traffic monitoring
- API management

Tech:
- Next.js
- TailwindCSS

Duration:
1-2 weeks

---

# PHASE 5 — Production Readiness

Features:
- TLS
- Wildcard domains
- Rate limiting
- Redis registry
- Horizontal scaling
- Monitoring
- Metrics

Duration:
2-4 weeks

---

# PHASE 6 — Advanced Tunneling

Features:
- Raw TCP
- UDP
- SSH tunnel
- QUIC
- Peer-to-peer

Duration:
Long-term

---

# 5. Core Components

# A. Tunnel Gateway Server

Responsibilities:
- Accept WebSocket clients
- Maintain active tunnels
- Route requests
- Handle multiplexing
- Forward traffic

Folder:
```text
apps/gateway-server/
```

Modules:
```text
src/
├── websocket/
├── routing/
├── proxy/
├── auth/
├── tunnels/
├── streams/
├── metrics/
└── utils/
```

---

# B. Tunnel Client Agent

Responsibilities:
- Connect to gateway
- Keep persistent socket
- Proxy localhost traffic
- Reconnect automatically

Folder:
```text
apps/tunnel-client/
```

Modules:
```text
src/
├── connection/
├── localproxy/
├── heartbeat/
├── reconnect/
├── streams/
└── config/
```

---

# C. Dashboard API

Responsibilities:
- User management
- Tunnel management
- Metrics
- Authentication

Folder:
```text
apps/dashboard-api/
```

---

# 6. Protocol Design

# WebSocket Frame Types

```json
{
  "type": "register_tunnel"
}
```

```json
{
  "type": "http_request"
}
```

```json
{
  "type": "http_response"
}
```

```json
{
  "type": "stream_chunk"
}
```

```json
{
  "type": "heartbeat"
}
```

---

# 7. Multiplexing Design

## Why Needed

One WebSocket must support:
- multiple HTTP requests
- multiple concurrent streams

## Solution

Use:
```text
streamId
```

Example:
```json
{
  "streamId": "abc123",
  "type": "http_request"
}
```

Each request gets unique stream ID.

---

# 8. Tunnel Request Lifecycle

# Step 1

Client connects:
```text
wss://gateway.example.com/connect
```

---

# Step 2

Server assigns:
```text
abc123.example.com
```

---

# Step 3

Public user visits:
```text
https://abc123.example.com
```

---

# Step 4

Gateway:
- finds tunnel
- forwards request over websocket

---

# Step 5

Client:
- proxies request to localhost
- returns response

---

# 9. Gateway Server Internal Flow

```text
Incoming HTTP Request
        ↓
Extract Subdomain
        ↓
Find Tunnel Session
        ↓
Open Stream
        ↓
Forward Request
        ↓
Receive Response
        ↓
Return To Internet User
```

---

# 10. Tunnel Client Internal Flow

```text
Receive Stream
        ↓
Convert To Local HTTP Request
        ↓
Forward To localhost
        ↓
Capture Response
        ↓
Send Response Back
```

---

# 11. Recommended MVP APIs

# Register Tunnel

```http
POST /api/tunnels
```

Response:
```json
{
  "subdomain": "abc123"
}
```

---

# List Tunnels

```http
GET /api/tunnels
```

---

# Delete Tunnel

```http
DELETE /api/tunnels/:id
```

---

# 12. Recommended Database Schema

# Users

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY,
  email TEXT,
  password_hash TEXT
);
```

---

# Tunnels

```sql
CREATE TABLE tunnels (
  id UUID PRIMARY KEY,
  user_id UUID,
  subdomain TEXT,
  created_at TIMESTAMP
);
```

---

# Tunnel Sessions

```sql
CREATE TABLE tunnel_sessions (
  id UUID PRIMARY KEY,
  tunnel_id UUID,
  connected BOOLEAN,
  last_heartbeat TIMESTAMP
);
```

---

# 13. Security Requirements

Mandatory:
- TLS everywhere
- JWT validation
- Tunnel ownership checks
- Request size limits
- Rate limiting
- Abuse prevention

Never expose:
- raw internal IPs
- unrestricted proxying

---

# 14. Streaming Strategy

DO NOT buffer entire requests.

Bad:
```text
Receive full request
Store in memory
Send later
```

Good:
```text
Chunk request
Stream incrementally
Use backpressure
```

---

# 15. Infrastructure Layout

```text
Internet
   ↓
Cloudflare
   ↓
Caddy/Nginx
   ↓
Gateway Cluster
   ↓
Redis
   ↓
PostgreSQL
```

---

# 16. Recommended VPS Specs

MVP:
- 2 CPU
- 4GB RAM

Production:
- 4+ CPU
- 8GB+ RAM

Providers:
- Hetzner
- DigitalOcean
- AWS
- Vultr

---

# 17. Dev Environment Setup

# Install

```bash
node -v
npm -v
docker -v
```

---

# Create Monorepo

```bash
mkdir tunnel-platform
cd tunnel-platform
npm init -y
```

---

# Install Core Dependencies

```bash
npm install fastify ws http-proxy jsonwebtoken
```

---

# Dev Dependencies

```bash
npm install -D typescript ts-node nodemon
```

---

# 18. Recommended Initial Folder Structure

```text
gateway-server/
│
├── src/
│   ├── index.ts
│   ├── websocket.ts
│   ├── registry.ts
│   ├── router.ts
│   ├── proxy.ts
│   ├── protocol.ts
│   └── types.ts
│
├── package.json
└── tsconfig.json
```

---

# 19. Minimal MVP Features Checklist

## Gateway
- [ ] Accept websocket clients
- [ ] Assign subdomains
- [ ] Maintain tunnel registry
- [ ] Route incoming HTTP requests

## Client
- [ ] Connect to gateway
- [ ] Reconnect automatically
- [ ] Proxy localhost requests

## Protocol
- [ ] Stream IDs
- [ ] Heartbeats
- [ ] Request/response forwarding

---

# 20. AI-Assisted Development Workflow

Best workflow:

## Step 1
Build one module at a time.

## Step 2
Use AI prompts like:

```text
Create a Fastify websocket tunnel server using ws library.
```

---

## Step 3
Then:

```text
Add stream multiplexing support.
```

---

## Step 4
Then:

```text
Implement localhost forwarding inside tunnel client.
```

---

# 21. Suggested AI Prompting Strategy

# Good Prompt Example

```text
Build a TypeScript websocket gateway server.

Requirements:
- Fastify
- ws
- tunnel registry
- subdomain routing
- request forwarding
- modular architecture
- production-ready structure
```

---

# 22. Long-Term Scaling Plan

Eventually you will need:

- Redis pub/sub
- distributed tunnel registry
- multiple gateway nodes
- sticky sessions
- stream brokers

Architecture evolves into:
```text
Load Balancer
    ↓
Gateway Cluster
    ↓
Redis
    ↓
Tunnel Workers
```

---

# 23. Recommended Open Source Projects To Study

## MUST STUDY

FRP:
https://github.com/fatedier/frp

Rathole:
https://github.com/rapiz1/rathole

OpenPort:
https://github.com/openportio/openport-go

---

# 24. Recommended Learning Order

1. TCP basics
2. HTTP proxying
3. WebSockets
4. Streaming
5. Backpressure
6. Multiplexing
7. TLS
8. Reverse proxying
9. Horizontal scaling

---

# 25. Critical Engineering Problems

You WILL eventually face:
- socket leaks
- memory leaks
- half-open streams
- stalled connections
- backpressure issues
- websocket fragmentation
- reconnect storms

Design carefully.

---

# 26. Production Recommendations

## Use TypeScript

Mandatory for maintainability.

---

## Use Structured Logging

Recommended:
- pino

---

## Monitoring

Recommended:
- Prometheus
- Grafana

---

## CI/CD

Recommended:
- GitHub Actions

---

# 27. Recommended MVP Timeline

| Week | Goal |
|---|---|
| 1 | Basic websocket tunnel |
| 2 | HTTP forwarding |
| 3 | Multi-tunnel support |
| 4 | Auth system |
| 5 | Dashboard |
| 6 | Production hardening |

---

# 28. Final Advice

Do NOT over-engineer early.

The correct progression is:

1. One websocket tunnel
2. One forwarded HTTP request
3. Multiple concurrent requests
4. Multiple clients
5. Authentication
6. Dashboard
7. Scaling

Focus on:
- stability
- reconnect logic
- streaming correctness

before adding advanced features.

---

# 29. Suggested First Milestone

Your FIRST milestone should be:

```text
localhost:3000
↓
public URL
↓
browser can access local app
```

If you achieve that:
you already built the foundation of a real tunnel platform.

