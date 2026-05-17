# Portivox

Portivox lets you expose local services over **HTTP** and **raw TCP** (SSH/RDP ready).

## Security Documentation

- Customer-facing summary: `docs/SECURITY_SUMMARY.md`
- Full technical details: `docs/FEATURES_SECURITY.md`
- NGINX single-subdomain setup: `docs/NGINX_SINGLE_SUBDOMAIN.md`
- Production deployment: `docs/PRODUCTION_DEPLOYMENT.md`
- Standalone client publish: `docs/CLIENT_PUBLISH.md`

## What You Need
- Node.js 22+
- npm
- A running Portivox gateway (your own deployment)
- An API key (from gateway admin/user flow)

---

## 1) Install

```bash
npm install
```

### Client-only install (recommended for customers)

After publishing `portivox-client` package, customers install only client:

```bash
npm install -g portivox-client
```

### Docker Shortcuts

```bash
npm run docker:dev:up
npm run docker:dev:down
npm run docker:prod:up
npm run docker:prod:down
```

Optional (global command):

```bash
npm link
```

Then you can run:

```bash
portivox
```

---

## 2) Start Gateway (self-hosted)

### Option A: Local dev
```bash
npm run dev:gateway
```

### Option B: Docker
```bash
docker compose up --build
```

By default (with NGINX):
- App UI + API: `http://app.localtest.me`
- Gateway WS (for tunnel client): `ws://localhost:7000/connect`
- Tunnel ingress host pattern: `http://<subdomain>.app.localtest.me`

For local testing, add hosts entries:
- `127.0.0.1 app.localtest.me`
- `127.0.0.1 demo.app.localtest.me` (or any tunnel subdomain you test)

## Frontend Console (React + Vite)

Start user frontend:

```bash
npm run dev:frontend
```

Open:

```text
http://localhost:5173
```

Frontend supports:
- Self register/login (JWT)
- API key login (optional)
- Tunnel list
- Tunnel create
- Tunnel delete
- Admin panel (system state, key management, diagnostics, audit)

---

## 3) Register Client Key (one-time on customer machine)

Fastest interactive way (single command with menu):

```bash
npm run portivox
```

or (if globally linked/installed):

```bash
portivox
```

Save your API key locally:

```bash
npm run portivox:register -- tk_your_api_key
```

Optional custom gateway:

```bash
npm run portivox:register -- tk_your_api_key --gateway ws://your-gateway:7000/connect
```

Saved config path:
- Windows: `%USERPROFILE%\\.portivox\\client.json`
- Linux/macOS: `~/.portivox/client.json`

---

## 4) Expose Any Local Port

### HTTP tunnel
Expose local port `3000`:

```bash
npm run portivox:open -- 3000
```

Optional:
- Custom subdomain:
  ```bash
  npm run portivox:open -- 3000 --subdomain myapp
  ```
- Custom host bind (default `127.0.0.1`):
  ```bash
  npm run portivox:open -- 3000 --host 0.0.0.0
  ```
- Custom gateway:
  ```bash
  npm run portivox:open -- 3000 --gateway ws://your-gateway:7000/connect
  ```

When connected, the client prints the assigned subdomain/session details.

### TCP tunnel (SSH/RDP/DB)
Expose local port `22` as a raw TCP tunnel:

```bash
npm run portivox:open -- 22 --tcp
```

Custom TCP example for RDP:

```bash
npm run portivox:open -- 3389 --tcp --host 127.0.0.1
```

When connected, client prints `TCP endpoint: <host>:<port>`.  
Use that host/port from remote machine to connect over SSH/RDP/TCP client.

---

## 5) Access Your Exposed App

If your root domain is `app.localtest.me` and assigned subdomain is `demo`, access:

```text
http://demo.app.localtest.me
```

In local testing (without DNS), you can simulate host routing:

```bash
curl -H "Host: demo.app.localtest.me" http://localhost/
```

---

## Windows Quick Start

Gateway:
```bash
npm run start:gateway:win
```

Client:
```bash
npm run start:client:win
```

---

## Linux Quick Start

Gateway:
```bash
npm run start:gateway:linux
```

Client:
```bash
npm run start:client:linux
```

---

## Common Troubleshooting

- `No API key found`  
  Run:
  ```bash
  npm run portivox:register -- tk_your_api_key
  ```

- `401/403 unauthorized`  
  Check key validity and scopes on gateway.

- Public URL not reachable  
  Ensure:
  - gateway is running
  - wildcard DNS points to gateway
  - root domain matches gateway config

- Local app not reachable through tunnel  
  Check local app is running on the same port you opened.

## Validation

Run smoke tests:

```bash
npm run test:smoke
npm run test:smoke:tcp
npm run test:smoke:docker
```

---

## TCP Gateway Settings

Configure gateway for TCP public listeners:
- `TCP_TUNNEL_ENABLED=true`
- `TCP_TUNNEL_BIND_HOST=0.0.0.0`
- `TCP_PUBLIC_HOST=your.public.ip.or.dns`
- `TCP_PUBLIC_PORT_START=19000`
- `TCP_PUBLIC_PORT_END=19999`
