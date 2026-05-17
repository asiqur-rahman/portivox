# Portivox MVP Roadmap

## Current Status

Implemented foundations:
- workspace structure
- protocol package
- tunnel registry
- subdomain generation
- gateway configuration

## Next Engineering Targets

### Gateway
- websocket transport
- active connection manager
- heartbeat expiration
- HTTP ingress routing

### Client
- websocket connection
- reconnect strategy
- localhost proxy forwarding

### Infrastructure
- docker compose
- local development stack
- CI pipeline

## MVP Definition

Success condition:

```text
localhost:3000
â†“
public tunnel URL
â†“
remote browser access
```

