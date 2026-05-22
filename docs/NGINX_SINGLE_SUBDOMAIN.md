# NGINX Single-Subdomain Setup

This project now includes an NGINX reverse proxy to run the user app, API, websocket control plane, and tunnel ingress under one domain family.

## Domain Model

- App domain (UI + API + WS): `portivox.braintechsolution.com`
- Tunnel domains: `*.portivox.braintechsolution.com` (example: `demo.portivox.braintechsolution.com`)

## Routing Rules

On `portivox.braintechsolution.com`:
- `/` -> Frontend (React build)
- `/api/*` -> Gateway HTTP API
- `/connect` -> Gateway WebSocket endpoint

On `*.portivox.braintechsolution.com`:
- `/*` -> Gateway tunnel ingress

## Docker Compose

Start stack:

```bash
docker compose up --build
```

Public entrypoint is NGINX on port `80`.

## Local Hosts Entries

Add these for local testing:

- `127.0.0.1 portivox.braintechsolution.com`
- `127.0.0.1 demo.portivox.braintechsolution.com`

## Files

- NGINX config: `infra/nginx/nginx.conf`
- NGINX image build: `infra/nginx/Dockerfile`
- Compose wiring: `docker-compose.yml`

## Notes

- Tunnel clients still connect to gateway websocket on `ws://localhost:7000/connect` in local docker setup.
- For production, place TLS in front of NGINX (or terminate at NGINX with certs) and use `wss://` for client websocket.

