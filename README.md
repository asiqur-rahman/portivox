# Tunnelix

Self-hosted reverse tunneling platform inspired by ngrok, FRP, and OpenPort.

## MVP Features

- WebSocket gateway server
- Tunnel registration
- Dynamic subdomain allocation
- Heartbeat transport
- Auto reconnecting tunnel client
- In-memory tunnel registry
- Docker development environment

## Repository Structure

```text
apps/
  gateway-server/
  tunnel-client/
packages/
  protocol/
docs/
```

## Local Development

### Start With Docker

```bash
docker compose up
```

### Manual Runtime

Install:

```bash
npm install
```

Run gateway:

```bash
npm run dev:gateway
```

Run client:

```bash
npm run dev:client
```

## Gateway Endpoints

### Health Check

```http
GET /health
```

### Active Tunnels

```http
GET /api/tunnels
```

### Tunnel WebSocket

```text
ws://localhost:8080/connect
```

## MVP Flow

```text
Tunnel Client
    ↓
WebSocket Connection
    ↓
Gateway Registration
    ↓
Subdomain Assignment
    ↓
Heartbeat Maintenance
```

## Current Limitations

Current implementation is MVP-only.

Not yet implemented:
- real HTTP forwarding
- TCP streams
- authentication
- persistence
- TLS
- distributed scaling
- dashboard

## Next Phase

Next engineering target:

```text
localhost:3000
↓
remote browser access
```
