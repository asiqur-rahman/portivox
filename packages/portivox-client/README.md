# Portivox Client Package

Publishable standalone client package.

## Build

```bash
npm run -w packages/portivox-client build
```

## Local pack test

```bash
npm pack --workspace packages/portivox-client
npm install -g ./packages/portivox-client/portivox-client-0.1.0.tgz
```

## Usage

```bash
portivox register <apiKey>
portivox open 3000 --subdomain myapp
portivox open 22 --tcp --subdomain myssh
```

## Advanced gateway override

```bash
portivox register <apiKey> --gateway wss://your-gateway.example.com/connect
portivox open 3000 --gateway wss://your-gateway.example.com/connect
```

