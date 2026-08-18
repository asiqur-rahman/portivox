<div align="center">

<img src="docs/logo.svg" alt="Portivox Logo" width="80" height="80" />

# Portivox

### Self-hosted HTTP and TCP tunnels — your own ngrok, under your control

> **Porti** — from *portal*, the doorway that carries traffic from a private service to the public internet  
> **-vox** — from *voice*, the control plane that speaks for every tunnel you open

**Portivox** is a self-hosted tunnel gateway that exposes local HTTP and raw TCP services (SSH, RDP, databases) through a web dashboard, API keys, IP-link protection, and wildcard subdomain routing — without handing your traffic to a third-party SaaS.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Node.js](https://img.shields.io/badge/Node.js-22+-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![React](https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev)
[![Fastify](https://img.shields.io/badge/Fastify-5-000000?style=flat-square&logo=fastify&logoColor=white)](https://fastify.dev)
[![MySQL](https://img.shields.io/badge/MySQL-8-4479A1?style=flat-square&logo=mysql&logoColor=white)](https://www.mysql.com)
[![Redis](https://img.shields.io/badge/Redis-7-DC382D?style=flat-square&logo=redis&logoColor=white)](https://redis.io)
[![Docker](https://img.shields.io/badge/Docker-Hub-2496ED?style=flat-square&logo=docker&logoColor=white)](https://hub.docker.com/r/asiqurrahman/portivox-gateway)
[![CasaOS](https://img.shields.io/badge/CasaOS-Import-4338CA?style=flat-square)](casaos-portivox-final.yml)
[![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)
[![Author](https://img.shields.io/badge/Author-Md.%20Asiqur%20Rahman%20Khan-0969da?style=flat-square&logo=github&logoColor=white)](https://github.com/asiqur-rahman)

[What is Portivox?](#-what-is-portivox) · [Features](#-features) · [Quick Start](#-quick-start) · [CasaOS](#-casaos-install) · [Docker Hub](#-docker-hub-publish) · [Architecture](#-architecture) · [Configuration](#-configuration) · [Client](#-tunnel-client) · [Deployment](#-production-deployment)

---

*Developed and maintained by **[Md. Asiqur Rahman Khan](https://github.com/asiqur-rahman)***

</div>

---

## 💡 What is Portivox?

Every local service has a question it must answer when someone outside the LAN needs it:

> ***"How do I reach this port on my machine — without opening my whole network?"***

**Portivox** is the system that answers that question, on infrastructure you own.

A laptop, a NAS, or a home lab runs the **tunnel client**. It opens a persistent WebSocket to your **gateway**. The gateway publishes that service as an HTTP URL, a dedicated public port, or a raw TCP endpoint. You share a link — not your private IP.

```
A local app listens on 127.0.0.1:3000
        ↓
portivox open 3000  →  WebSocket control plane to your gateway
        ↓
Public users reach https://your-domain:19005  (or a subdomain, if entitled)
        ↓
The gateway forwards bytes to the client, which hits localhost — nothing else is exposed
```

### What makes Portivox different from ngrok?

ngrok is the hosted product. **Portivox is the platform you run.**

| Hosted ngrok | Portivox |
|---|---|
| Traffic and URLs live on someone else's cloud | You own the gateway, DNS, and data |
| Agent talks to a vendor control plane | Agent talks to **your** Docker / CasaOS stack |
| HTTP + TCP as a SaaS feature | HTTP + raw TCP (SSH, RDP, databases) on your ports |
| Limited admin visibility | Web console: tunnels, keys, devices, audit, usage |
| IP restriction as a paid extra | Secret access links (`/l/<token>`) keep ports dark until opened |
| One vendor, one bill | MIT-licensed, self-hosted, no usage tax |

### Who is Portivox for?

- **Developers** who need a public URL for a local API or webhook
- **Homelab / CasaOS / NAS** operators who want tunnels next to the rest of their apps
- **MSPs and IT teams** exposing customer-site services without a VPN mesh
- **Anyone** who will not send SSH, RDP, or database traffic through a third party

### The name

**Portivox** = *portal* (the doorway) + *vox* (the voice of the control plane). Every tunnel is a portal; the gateway is the voice that announces it to the world.

---

## Overview

**Use Portivox when you need to:**
- Expose **HTTP apps** on a dedicated public port (and optional subdomain)
- Expose **raw TCP** for SSH, RDP, or databases
- Keep ports **dark** until a secret access link is opened in a browser
- Manage tunnels, API keys, devices, and users from a **web dashboard**
- Run a **multi-node** gateway with Redis leases
- Keep everything **on your own infrastructure** — Docker Compose or CasaOS

Further reading:

- Customer security summary: [`docs/SECURITY_SUMMARY.md`](docs/SECURITY_SUMMARY.md)
- Features and controls: [`docs/FEATURES_SECURITY.md`](docs/FEATURES_SECURITY.md)
- NGINX / single-domain routing: [`docs/NGINX_SINGLE_SUBDOMAIN.md`](docs/NGINX_SINGLE_SUBDOMAIN.md)
- Production notes: [`docs/PRODUCTION_DEPLOYMENT.md`](docs/PRODUCTION_DEPLOYMENT.md)
- npm client publish: [`docs/CLIENT_PUBLISH.md`](docs/CLIENT_PUBLISH.md)

---

## ✨ Features

### 🔐 Access & identity

| Feature | Details |
|---|---|
| **JWT auth** | Register / login in the web console; `AUTH_JWT_SECRET` required in production |
| **API keys** | Scoped keys for the CLI (`tunnel:create`, `tunnel:read`, `key:manage`, …) |
| **Roles** | Owners manage their own tunnels; platform admins (`ADMIN_EMAILS`) reach `/api/admin/*` |
| **CORS allowlist** | Browser origins must match `CORS_ALLOWED_ORIGINS` |
| **Rate limits** | Separate read / write / admin / ingress limits per IP |

### 🌐 HTTP & TCP tunnels

| Feature | Details |
|---|---|
| **Dedicated public ports** | Default HTTP tunnels bind `TCP_PUBLIC_PORT_START`–`END` (19000–19099) |
| **Wildcard subdomains** | `*.ROOT_DOMAIN` when a platform admin enables the entitlement |
| **Raw TCP** | `portivox open 22 --tcp` for SSH, RDP, databases |
| **IP-link protection** | Port stays dark until `/l/<token>` is opened; 24h IP allowlist |
| **Stable status URLs** | `/r/<token>` reports tunnel state without granting access |
| **Remote close** | Deleting a tunnel in the console tells the connected client to stop immediately |

### 🖥 Console & operations

| Feature | Details |
|---|---|
| **Web dashboard** | Tunnels, API keys, devices, inspector, usage, billing, settings |
| **Admin panel** | Users & subscriptions, gateway status, TCP maps, audit log |
| **Live events** | SSE refresh when tunnels, keys, or sessions change |
| **OpenAPI** | `/openapi.json` exported and checked in CI |
| **Health** | `/healthz` and `/readyz` for orchestrators |
| **Audit export** | Optional JSONL file and HMAC-signed webhook |

### 🏗 Infrastructure

| Feature | Details |
|---|---|
| **Docker Compose** | nginx + gateway + Redis (`make up`) |
| **CasaOS import** | One YAML: nginx, gateway, MySQL, Redis — [`casaos-portivox-final.yml`](casaos-portivox-final.yml) |
| **Docker Hub** | `asiqurrahman/portivox-gateway` and `asiqurrahman/portivox-nginx` (`make push`) |
| **MySQL or PostgreSQL** | `DB_PROVIDER` selects the Prisma schema at image build time |
| **Redis registry** | Required for production / multi-node leases |
| **PWA** | Installable console with a service worker |

---

## 🏗 Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Client layer                              │
│  Web console (React SPA)     CLI / SDK (portivox-client)    │
│  HTTPS                       WSS /connect                    │
└──────────────────────────┬──────────────────────────────────┘
                           │ nginx :80  (CasaOS host :8180)
┌──────────────────────────▼──────────────────────────────────┐
│  nginx — SPA + /api + /connect + *.ROOT_DOMAIN ingress       │
└───────────────┬──────────────────────────┬──────────────────┘
                │ HTTP :8080               │ WS :7000
┌───────────────▼──────────────────────────▼──────────────────┐
│              Gateway (Fastify)                               │
│  Auth · tunnels · keys · TCP bind 19000–19099 · audit        │
└────────┬─────────────────────────────────┬──────────────────┘
         │ Prisma                          │ Redis registry
┌────────▼───────────┐           ┌─────────▼──────────────────┐
│  MySQL 8 / Postgres │           │  Redis 7 (leases + AOF)    │
└────────────────────┘           └────────────────────────────┘
```

Containers are always named `portivox-*`:

| Container | Role |
|---|---|
| `portivox-nginx` | Dashboard, API proxy, WebSocket `/connect`, subdomain ingress |
| `portivox-gateway` | Control plane + TCP/HTTP public-port listeners |
| `portivox-mysql` | Application database (CasaOS stack; Compose can use an external DB) |
| `portivox-redis` | Tunnel registry and session store |

nginx inside the image still resolves the gateway as hostname `gateway` (Compose service name / CasaOS network alias).

---

## 🚀 Quick Start

### Prerequisites

| Requirement | Version |
|---|---|
| Docker + Docker Compose | v2.20+ |
| Node.js (dev / CLI from source) | 22+ |
| Wildcard DNS (production) | `*.your-domain` → gateway host |

### Option A — CasaOS (recommended on a NAS)

See [CasaOS install](#-casaos-install). Dashboard: `http://<casaos-host>:8180`.

### Option B — Docker Compose (from this repo)

```bash
git clone https://github.com/asiqur-rahman/portivox.git
cd portivox
cp .env.example .env
```

Set at least:

```env
AUTH_JWT_SECRET=<32+ random chars>
DATABASE_URL=mysql://user:pass@host:3306/portivox
GATEWAY_PUBLIC_BASE_URL=https://your-domain
CORS_ALLOWED_ORIGINS=https://your-domain
ROOT_DOMAIN=your-domain
TCP_PUBLIC_HOST=your-domain
```

```bash
make up          # nginx + gateway + redis (build if needed)
# First boot: gateway entrypoint runs Prisma migrations when DATABASE_URL is set
```

Open `http://localhost:${NGINX_PORT:-80}` (or your `ROOT_DOMAIN` if DNS/hosts point here).

```bash
make logs        # follow logs
make ps          # container status
make down        # stop; keep Redis volume
make clean       # stop, wipe volumes, remove local images
```

Equivalent npm scripts: `npm run docker:up`, `docker:rebuild`, `docker:down`, `docker:clean`, `docker:logs`, `docker:ps`.

### Option C — Local development

```bash
npm install
npm run dev:gateway     # gateway
npm run dev:frontend    # console at http://localhost:5173
```

---

## 🏠 CasaOS install

Import the ready-made compose file. No git clone on the NAS.

1. CasaOS → **App Store** → **Custom Install** → import [`casaos-portivox-final.yml`](casaos-portivox-final.yml).
2. Change these **before production** (CasaOS splits env values on extra `=` — do not put `=` in secrets or in `DATABASE_URL` query strings):
   - `MYSQL_PASSWORD`, `MYSQL_ROOT_PASSWORD`, and `DATABASE_URL` (must match)
   - `AUTH_JWT_SECRET` (min 32 characters)
   - `ROOT_DOMAIN`, `GATEWAY_PUBLIC_BASE_URL`, `CORS_ALLOWED_ORIGINS`, `TCP_PUBLIC_HOST`
3. Point DNS:
   - `your-domain` → CasaOS host
   - `*.your-domain` → same host
4. Open firewall **TCP 8180** (dashboard) and **TCP 19000–19099** (public-port / TCP tunnels).
5. Start the app. Register the first user in the web UI. Platform admins are emails listed in `ADMIN_EMAILS`.

| Item | Value |
|---|---|
| Dashboard | `http://<host>:8180` |
| Tunnel client | `ws://<host>:8180/connect` (or `wss://` behind TLS) |
| Images | `asiqurrahman/portivox-nginx:production` · `asiqurrahman/portivox-gateway:production` |
| Data | `/DATA/AppData/portivox/mysql` · `/DATA/AppData/portivox/redis` |

The published gateway image is built with **`DB_PROVIDER=mysql`**.

---

## 🐳 Docker Hub publish

Custom images:

- [asiqurrahman/portivox-gateway](https://hub.docker.com/r/asiqurrahman/portivox-gateway)
- [asiqurrahman/portivox-nginx](https://hub.docker.com/r/asiqurrahman/portivox-nginx)

```bash
make push                     # interactive: last Hub version → next patch/minor/major
make push VERSION=1.2.3       # non-interactive
node ops/docker-push.mjs --skip-push --version 1.2.3   # build locally only
```

Each publish tags **semver**, **`latest`**, **`production`**, and the **git SHA**.  
`DB_PROVIDER` defaults to `mysql` (override with `DB_PROVIDER=postgresql make push` if you maintain a Postgres image).

Requires Docker (native or WSL) and `docker login` to Docker Hub.

---

## 🗂 Repository layout

```
portivox/
├── apps/
│   ├── gateway-server/         Fastify gateway (HTTP + WebSocket + TCP)
│   ├── frontend/               React + Vite console
│   └── tunnel-client/          CLI that opens tunnels
├── packages/                   Shared auth, config, protocol, SDK, logger
├── prisma/                     MySQL + PostgreSQL schemas and migrations
├── infra/nginx/                Reverse proxy + SPA image
├── ops/docker-push.mjs         Docker Hub version picker + build/push
├── casaos-portivox-final.yml   CasaOS import (nginx, gateway, MySQL, Redis)
├── docker-compose.yml          Dev/prod compose (nginx, gateway, redis)
└── .env.example                Environment template
```

---

## ⚙ Configuration

All tuneable values live in `.env` (see `.env.example`). CasaOS sets the same keys in the import YAML.

### Required in production

```env
AUTH_REQUIRED=true
AUTH_JWT_SECRET=                    # min 32 chars, not a placeholder
ROOT_DOMAIN=portivox.example.com
GATEWAY_PUBLIC_BASE_URL=https://portivox.example.com
CORS_ALLOWED_ORIGINS=https://portivox.example.com
DB_PROVIDER=mysql                   # or postgresql — must match DATABASE_URL
DATABASE_URL=mysql://portivox:password@mysql:3306/portivox
TCP_PUBLIC_HOST=portivox.example.com
TCP_PUBLIC_PORT_START=19000
TCP_PUBLIC_PORT_END=19099
```

Generate a JWT secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Database

Compose expects `DATABASE_URL` to reach a MySQL or PostgreSQL instance you provide. CasaOS includes MySQL 8 in the stack.

```bash
npm run db:generate
npm run db:migrate
npm run db:migrate:deploy
```

### TCP / public ports

```env
TCP_TUNNEL_ENABLED=true
TCP_TUNNEL_BIND_HOST=0.0.0.0
IP_PROTECTION_DEFAULT=true          # ports stay dark until the access link is opened
TCP_CONNECTION_RATE_LIMIT=10
HTTP_PUBLIC_PORT_MODE=true
```

---

## 💻 Tunnel client

### Install

From this repo:

```bash
npm install
npm run -w apps/tunnel-client build
```

Customers (after npm publish):

```bash
npm install -g portivox-client
```

Interactive helper from the repo:

```bash
npm run portivox
```

### Register a key and open a tunnel

Create an API key in the web console, then:

```bash
portivox register tk_your_api_key --gateway wss://your-domain/connect
portivox open 3000
portivox open 3000 --subdomain myapp      # requires subdomain entitlement
portivox open 3000 --no-ip-protection     # open the public port immediately
portivox open 22 --tcp                    # SSH / raw TCP
portivox list
```

Config path:

- Windows: `%USERPROFILE%\.portivox\client.json`
- Linux / macOS: `~/.portivox/client.json`

**Subdomains** are a per-user entitlement. By default HTTP tunnels get a dedicated public port only (`your-domain:19000`). A platform admin enables subdomains under **Users & Subscriptions** (`PATCH /api/admin/users/:id` with `subdomainEnabled: true`).

### Reach the service

```text
http://your-domain:19000                 # dedicated public port
http://demo.your-domain                  # subdomain (if entitled)
https://your-domain/l/<token>            # secret access link (IP allowlist)
https://your-domain/r/<token>            # stable status JSON
```

Local hosts file for lab DNS:

```text
127.0.0.1  portivox.braintechsolution.com
127.0.0.1  demo.portivox.braintechsolution.com
```

---

## 🌐 Production deployment

### Docker Compose

```bash
# 1. Strong AUTH_JWT_SECRET, real ROOT_DOMAIN / public URLs, AUTH_REQUIRED=true
# 2. Wildcard DNS + TLS in front of nginx (load balancer or nginx certs)
# 3. Open TCP 19000–19099 on the host firewall
docker compose up -d --build
```

Tunnel clients should use `wss://your-domain/connect` when TLS terminates in front of nginx.

### Production checklist

- [ ] Change `AUTH_JWT_SECRET`, MySQL passwords, and `DATABASE_URL` (no extra `=` for CasaOS)
- [ ] Set `ROOT_DOMAIN`, `GATEWAY_PUBLIC_BASE_URL`, `CORS_ALLOWED_ORIGINS`, `TCP_PUBLIC_HOST`
- [ ] Keep `AUTH_REQUIRED=true`
- [ ] Point wildcard DNS at the gateway host
- [ ] Terminate TLS; use `wss://` for the client
- [ ] Open host TCP **19000–19099**
- [ ] Set `ADMIN_EMAILS` for the first platform admin
- [ ] Back up MySQL (`/DATA/AppData/portivox/mysql` on CasaOS) and Redis AOF
- [ ] Rotate API keys on a schedule

---

## 🔧 Development

```bash
npm run dev:gateway
npm run dev:frontend
npm run dev:client -- open 3000 --gateway ws://localhost:7000/connect

npm run typecheck
npm run test:smoke
npm run test:smoke:tcp
npm run test:smoke:docker
npm run test:e2e
```

| Service | Default URL |
|---|---|
| Console (dev Vite) | http://localhost:5173 |
| Console (Docker nginx) | http://localhost:80 (or `NGINX_PORT`) |
| Console (CasaOS) | http://localhost:8180 |
| Gateway HTTP | http://localhost:8080 |
| Gateway WebSocket | ws://localhost:7000/connect |
| Health | `/healthz` · `/readyz` · `/openapi.json` |

Publish `portivox-client` to npm: repo secret `NPM_TOKEN`, then tag `portivox-client-vX.Y.Z` matching `packages/portivox-client/package.json`. See [`docs/CLIENT_PUBLISH.md`](docs/CLIENT_PUBLISH.md).

---

## Common troubleshooting

| Symptom | What to check |
|---|---|
| `No API key found` | `portivox register tk_…` |
| `401` / `403` | Key validity and scopes; JWT secret on the gateway |
| Public URL not reachable | Gateway up, wildcard DNS, `ROOT_DOMAIN` matches nginx |
| CasaOS env looks truncated | Remove `=` from secrets and from `DATABASE_URL` query params |
| Local app not tunneled | App listening on the same host/port you passed to `open` |
| `AUTH_JWT_SECRET is too weak` | Use 32+ random characters, not `changeme` |

---

## 🤝 Contributing

Contributions, issues, and feature requests are welcome.  
See the [GitHub repository](https://github.com/asiqur-rahman/portivox).

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/your-feature`)
3. Ensure TypeScript passes (`npm run typecheck`)
4. Commit with a clear message
5. Open a pull request against `main`

**Maintainer:** [Md. Asiqur Rahman Khan](https://github.com/asiqur-rahman)

---

## 📄 License

MIT © [Md. Asiqur Rahman Khan](https://github.com/asiqur-rahman)

---

<div align="center">

**Portivox** — Self-hosted HTTP and TCP tunnels

*HTTP · TCP · API keys · IP-link protection · CasaOS · Docker Hub*

*"Your ports. Your gateway. Your control plane."*

Built by **[Md. Asiqur Rahman Khan](https://github.com/asiqur-rahman)**

</div>
