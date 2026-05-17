# Portivox

Portivox lets you expose a local app (any HTTP port) to a public URL.

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

By default:
- Gateway HTTP: `http://localhost:8080`
- Gateway WS: `ws://localhost:7000/connect`

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

---

## 5) Access Your Exposed App

If your root domain is `localtest.me` and assigned subdomain is `demo`, access:

```text
http://demo.localtest.me:8080
```

In local testing (without DNS), you can simulate host routing:

```bash
curl -H "Host: demo.localtest.me" http://localhost:8080/
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

---

## Important Note

Current Portivox tunnel data path is HTTP-oriented.  
Raw TCP/SSH forwarding (for `open 22`) is not implemented yet.
