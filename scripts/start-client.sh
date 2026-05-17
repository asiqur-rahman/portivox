#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TUNNEL_GATEWAY_URL="${TUNNEL_GATEWAY_URL:-ws://localhost:7000/connect}"
TUNNEL_LOCAL_URL="${TUNNEL_LOCAL_URL:-http://localhost:3000}"
TUNNEL_SUBDOMAIN="${TUNNEL_SUBDOMAIN:-}"

ARGS=("--gateway" "$TUNNEL_GATEWAY_URL" "--local" "$TUNNEL_LOCAL_URL")
if [[ -n "$TUNNEL_SUBDOMAIN" ]]; then
  ARGS+=("--subdomain" "$TUNNEL_SUBDOMAIN")
fi

echo "Starting tunnel client -> ${TUNNEL_GATEWAY_URL} => ${TUNNEL_LOCAL_URL}"
npm run -w apps/tunnel-client dev -- "${ARGS[@]}"