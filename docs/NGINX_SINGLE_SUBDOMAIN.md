# NGINX Single-Subdomain Setup

This project now includes an NGINX reverse proxy to run the user app, API, websocket control plane, and tunnel ingress under one domain family.

## Domain Model

- App domain (UI + API + WS): `app.localtest.me`
- Tunnel domains: `*.app.localtest.me` (example: `demo.app.localtest.me`)

## Routing Rules

On `app.localtest.me`:
- `/` -> Frontend (React build)
- `/api/*` -> Gateway HTTP API
- `/connect` -> Gateway WebSocket endpoint

On `*.app.localtest.me`:
- `/*` -> Gateway tunnel ingress

## Docker Compose

Start stack:

```bash
docker compose up --build
```

Public entrypoint is NGINX on port `80`.

## Local Hosts Entries

Add these for local testing:

- `127.0.0.1 app.localtest.me`
- `127.0.0.1 demo.app.localtest.me`

## Files

- NGINX config: `infra/nginx/nginx.conf`
- NGINX image build: `infra/nginx/Dockerfile`
- Compose wiring: `docker-compose.yml`

## Notes

- Tunnel clients still connect to gateway websocket on `ws://localhost:7000/connect` in local docker setup.
- For production, place TLS in front of NGINX (or terminate at NGINX with certs) and use `wss://` for client websocket.
