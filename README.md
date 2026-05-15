# Tunnelix

Self-hosted reverse tunneling platform inspired by ngrok, FRP, and OpenPort.

## MVP Goal

Expose a local application through a secure public tunnel.

```text
localhost:3000
↓
Tunnelix Client
↓
Tunnelix Gateway
↓
public-url.example.com
```

## Stack

- Node.js
- TypeScript
- Fastify
- ws
- Docker

## Repository Structure

```text
apps/
  gateway-server/
  tunnel-client/
packages/
  protocol/
  shared-types/
```

## Development

```bash
npm install
npm run dev:gateway
```
