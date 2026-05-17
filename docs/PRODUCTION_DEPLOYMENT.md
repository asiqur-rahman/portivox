# Production Deployment Guide

This guide runs Portivox in a production-oriented Docker Compose topology.

## Included Services

- `nginx` (public entry for app + API + websocket)
- `gateway` (core Portivox server)
- `redis` (tunnel registry backend)
- external PostgreSQL or MySQL (managed or self-hosted), referenced by `DATABASE_URL`

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
- `DB_PROVIDER` (`postgresql` or `mysql`)
- `DATABASE_URL`

## 2) DNS Requirements

Create DNS records:
- `portivox.braintechsolution.com` -> gateway host/LB
- `* .portivox.braintechsolution.com` wildcard -> same host/LB

Example:
- `portivox.braintechsolution.com`
- `*.portivox.braintechsolution.com`

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
- `http://portivox.braintechsolution.com` (or HTTPS behind TLS)

## TLS Recommendation

For real production, terminate TLS on:
- external load balancer (recommended), or
- NGINX with certificate config.

Tunnel clients should use `wss://portivox.braintechsolution.com/connect` when TLS is enabled.

## TCP Tunnel Ports

Gateway publishes TCP tunnel range from env:
- `TCP_PUBLIC_PORT_START` to `TCP_PUBLIC_PORT_END`

Open that range in firewall/security groups.

## Operational Notes

- Keep `AUTH_REQUIRED=true`.
- Rotate API keys and JWT secret on schedule.
- Back up `postgres_data` and `redis_data` volumes.
- Keep Docker images patched and pinned in release process.

