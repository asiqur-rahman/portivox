# Production Deployment Guide

This guide runs Portivox in a production-oriented Docker Compose topology.

## Included Services

- `nginx` (public entry for app + API + websocket)
- `gateway` (core Portivox server)
- `redis` (tunnel registry backend)
- external Postgres (managed or self-hosted), referenced only by `DATABASE_URL`

## Files

- `docker-compose.prod.yml`
- `.env.production.example`
- `infra/nginx/nginx.prod.conf`

## 1) Prepare Environment

```bash
cp .env.production.example .env.production
```

Edit `.env.production` and set real values:
- `ROOT_DOMAIN`
- `TCP_PUBLIC_HOST`
- `AUTH_JWT_SECRET`
- `DATABASE_URL`

## 2) DNS Requirements

Create DNS records:
- `app.<your-domain>` -> gateway host/LB
- `* .app.<your-domain>` wildcard -> same host/LB

Example:
- `app.example.com`
- `*.app.example.com`

## 3) Start Stack

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

## 4) Apply DB Migrations

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production run --rm gateway npx prisma migrate deploy
```

## 5) Verify Health

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production ps
docker compose -f docker-compose.prod.yml --env-file .env.production logs -f gateway
```

App/API should be reachable on:
- `http://app.<your-domain>` (or HTTPS behind TLS)

## TLS Recommendation

For real production, terminate TLS on:
- external load balancer (recommended), or
- NGINX with certificate config.

Tunnel clients should use `wss://app.<your-domain>/connect` when TLS is enabled.

## TCP Tunnel Ports

Gateway publishes TCP tunnel range from env:
- `TCP_PUBLIC_PORT_START` to `TCP_PUBLIC_PORT_END`

Open that range in firewall/security groups.

## Operational Notes

- Keep `AUTH_REQUIRED=true`.
- Rotate API keys and JWT secret on schedule.
- Back up `postgres_data` and `redis_data` volumes.
- Keep Docker images patched and pinned in release process.
