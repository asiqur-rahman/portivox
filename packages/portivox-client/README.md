# Portivox Client

Portivox is a standalone CLI for exposing local services securely over the internet.

Use it to:

- share a local web app
- expose SSH through a TCP tunnel
- keep tunnels connected with an always-on service

## Install

```bash
npm install -g portivox-client
```

## Quick Start

### 1. Register your API key

```bash
portivox register <apiKey>
```

### 2. Expose a local web app

```bash
portivox 3000
```

The gateway prints a public URL like:

```text
http://portivox.braintechsolution.com:19000
```

### 3. Expose SSH or another TCP service

```bash
portivox tcp 22
```

## Common Commands

```bash
portivox register <apiKey>
portivox whoami
portivox doctor
portivox 3000
portivox expose 3000
portivox tcp 22
portivox list          # show tunnels this machine currently has open
portivox logout
```

## Managing Tunnels From the Web

Tunnels you open from the CLI show up in the web control panel under your
account (use an API key created in your account, not a shared one). You can
**remove any tunnel from the panel** — when you do, the connected client is told
to close that tunnel immediately and will not reconnect it.

`portivox list` shows the tunnels the current machine has open, with their
public address and stable status URL.

## Always-On Tunnels

Keep a tunnel connected across machine restarts:

```bash
portivox 3000 --always-on
portivox tcp 22 --always-on
```

Manage background services:

```bash
portivox services list
portivox services status
portivox services logs <name>
```

## Examples

Premium/admin-enabled named HTTP subdomain:

```bash
portivox open 3000 --subdomain myapp
```

Reserve a named TCP tunnel:

```bash
portivox open 22 --tcp --subdomain myssh
```

## Help

```bash
portivox --help
portivox --version
```

## For Developers

Most users do not need gateway overrides. If you are connecting to a custom Portivox deployment, use the setup flow:

```bash
portivox config
```
