# Portivox Client

The tunnel client establishes a persistent connection to the gateway server and forwards localhost traffic.

## Responsibilities

- Maintain websocket connection
- Send heartbeat frames
- Register tunnels
- Forward local HTTP traffic
- Forward raw TCP traffic
- Reconnect automatically

## Planned Runtime

```bash
npm run dev:client
```

