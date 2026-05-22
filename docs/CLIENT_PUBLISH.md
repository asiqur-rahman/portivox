# Publish Standalone `portivox-client`

This package is located at `packages/portivox-client` and is fully standalone (no gateway/prisma deps).

## Build

```bash
npm run client:build
```

## Pack local artifact

```bash
npm run client:pack
```

This creates `portivox-client-<version>.tgz` in repo root.

## Global install test from tarball

```bash
npm install -g ./portivox-client-0.1.0.tgz
portivox --help
```

## Publish to npm

```bash
npm login
npm publish --workspace packages/portivox-client --access public
```

## Customer install command

```bash
npm install -g portivox-client
```
