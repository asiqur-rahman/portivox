#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

GATEWAY_PORT="${GATEWAY_PORT:-8080}"
GATEWAY_WS_PORT="${GATEWAY_WS_PORT:-7000}"
ROOT_DOMAIN="${ROOT_DOMAIN:-localtest.me}"

export GATEWAY_PORT
export GATEWAY_WS_PORT
export ROOT_DOMAIN

echo "Starting gateway on :${GATEWAY_PORT} (ws:${GATEWAY_WS_PORT}) for *.${ROOT_DOMAIN}"
npm run dev:gateway