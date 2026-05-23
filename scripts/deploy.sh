#!/usr/bin/env bash
# =============================================================================
# scripts/deploy.sh — Portivox production deploy (bare-metal or Docker)
# =============================================================================
#
# Usage
# -----
#   bash scripts/deploy.sh              # bare-metal deploy (default)
#   bash scripts/deploy.sh --docker     # Docker Compose deploy
#   bash scripts/deploy.sh --docker --with-mysql   # Docker + local MySQL container
#
# Flags (all optional)
#   --docker           Use Docker Compose instead of bare-metal Node
#   --with-mysql       Include docker-compose.mysql.yml (local MySQL container)
#   --skip-pull        Skip `git pull` (useful if you pushed files manually)
#   --skip-build       Skip TypeScript compile (saves time if only .env changed)
#   --skip-migrate     Skip DB migrations (not recommended)
#   --branch <name>    Pull a specific branch (default: main)
#
# Requirements (bare-metal)
#   - Node 22+, npm 10+
#   - PM2 (npm i -g pm2) — OR — the script falls back to systemd, then SIGTERM
#   - .env present at the repo root (never committed — gitignored)
#
# Requirements (Docker)
#   - Docker + Docker Compose v2
#   - .env present at the repo root
#
# The script is safe to run multiple times. Every step is idempotent:
#   - `prisma migrate deploy` is a no-op when all migrations are applied
#   - `npm ci` uses the lock-file exactly
#   - PM2 `reload` performs a zero-downtime restart when possible
# =============================================================================
set -euo pipefail

# ── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

log()  { echo -e "${CYAN}[deploy]${NC} $*"; }
ok()   { echo -e "${GREEN}[deploy] ✔${NC} $*"; }
warn() { echo -e "${YELLOW}[deploy] ⚠${NC}  $*"; }
die()  { echo -e "${RED}[deploy] ✘${NC}  $*" >&2; exit 1; }

# ── Parse flags ───────────────────────────────────────────────────────────────
USE_DOCKER=false
WITH_MYSQL=false
SKIP_PULL=false
SKIP_BUILD=false
SKIP_MIGRATE=false
BRANCH="main"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --docker)       USE_DOCKER=true    ;;
    --with-mysql)   WITH_MYSQL=true    ;;
    --skip-pull)    SKIP_PULL=true     ;;
    --skip-build)   SKIP_BUILD=true    ;;
    --skip-migrate) SKIP_MIGRATE=true  ;;
    --branch)       BRANCH="$2"; shift ;;
    *) die "Unknown flag: $1" ;;
  esac
  shift
done

# ── Resolve project root ──────────────────────────────────────────────────────
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
log "Project root: ${BOLD}${ROOT_DIR}${NC}"
log "Mode: $([ "$USE_DOCKER" = true ] && echo 'Docker Compose' || echo 'Bare-metal Node')"

# ── Sanity checks ─────────────────────────────────────────────────────────────
[[ -f ".env" ]] || die ".env not found at ${ROOT_DIR}. Copy .env.example and fill in your values."
command -v node >/dev/null 2>&1 || die "Node.js not found in PATH."
command -v npm  >/dev/null 2>&1 || die "npm not found in PATH."

if $USE_DOCKER; then
  command -v docker >/dev/null 2>&1 || die "Docker not found in PATH."
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 not found. Install the 'compose' plugin."
fi

# ── Step 1: Pull latest code ──────────────────────────────────────────────────
if $SKIP_PULL; then
  warn "Skipping git pull (--skip-pull)"
else
  log "Pulling branch ${BOLD}${BRANCH}${NC} from origin..."
  git fetch origin
  git checkout "$BRANCH"
  git pull origin "$BRANCH"
  ok "Code up to date."
fi

# ── Docker path ───────────────────────────────────────────────────────────────
if $USE_DOCKER; then

  COMPOSE_FILES=(-f docker-compose.yml)
  if $WITH_MYSQL; then
    COMPOSE_FILES+=(-f docker-compose.mysql.yml)
    log "Including docker-compose.mysql.yml (local MySQL container)"
  fi

  log "Building and starting containers..."
  docker compose "${COMPOSE_FILES[@]}" up --build -d

  log "Waiting for gateway health-check..."
  RETRIES=30
  until docker compose "${COMPOSE_FILES[@]}" exec -T gateway \
      node -e "const h=require('node:http');const r=h.get('http://127.0.0.1:8080/healthz',res=>{process.exit(res.statusCode===200?0:1)});r.on('error',()=>process.exit(1));" 2>/dev/null; do
    RETRIES=$((RETRIES - 1))
    [[ $RETRIES -le 0 ]] && die "Gateway failed to become healthy. Run: docker compose logs gateway"
    sleep 3
  done

  ok "Gateway is healthy."
  log "Container status:"
  docker compose "${COMPOSE_FILES[@]}" ps
  exit 0
fi

# ── Bare-metal path ───────────────────────────────────────────────────────────

# Step 2: Install / update dependencies ────────────────────────────────────────
log "Installing production dependencies (npm ci)..."
npm ci --omit=dev --ignore-scripts
# Re-run only the prepare/build lifecycle scripts Prisma needs
npm rebuild --ignore-scripts=false 2>/dev/null || true
ok "Dependencies installed."

# Step 3: Generate Prisma client ───────────────────────────────────────────────
log "Generating Prisma client..."
node scripts/prisma-runner.cjs generate
ok "Prisma client generated."

# Step 4: Run database migrations ──────────────────────────────────────────────
if $SKIP_MIGRATE; then
  warn "Skipping DB migrations (--skip-migrate)"
else
  log "Running database migrations (idempotent)..."
  node scripts/prisma-runner.cjs migrate deploy
  ok "Migrations applied."

  # Quick connectivity check
  log "Testing DB connectivity..."
  if node scripts/test-db.cjs; then
    ok "DB connection verified."
  else
    die "DB connectivity check failed — check DATABASE_URL in .env"
  fi
fi

# Step 5: Build gateway + frontend ─────────────────────────────────────────────
if $SKIP_BUILD; then
  warn "Skipping build (--skip-build)"
else
  log "Building gateway..."
  npm run -w apps/gateway-server build
  ok "Gateway built."

  log "Building frontend..."
  npm run -w apps/frontend build
  ok "Frontend built."
fi

# Step 6: Restart the gateway process ─────────────────────────────────────────
log "Restarting gateway process..."

# ── PM2 (preferred) ───────────────────────────────────────────────────────────
if command -v pm2 >/dev/null 2>&1; then
  if pm2 describe portivox-gateway >/dev/null 2>&1; then
    pm2 reload ecosystem.config.cjs --update-env
    ok "Gateway reloaded via PM2 (zero-downtime)."
  else
    # First start — register the app and save the process list
    pm2 start ecosystem.config.cjs
    pm2 save
    ok "Gateway started via PM2 (first start)."
    warn "Run 'pm2 startup' once to enable auto-restart on server reboot."
  fi

# ── systemd (fallback) ────────────────────────────────────────────────────────
elif systemctl list-units --type=service 2>/dev/null | grep -q "portivox"; then
  SERVICE=$(systemctl list-units --type=service 2>/dev/null \
              | grep portivox \
              | awk '{print $1}' | head -1)
  sudo systemctl restart "$SERVICE"
  ok "Gateway restarted via systemd (${SERVICE})."

# ── Last-resort: SIGTERM the old process and start fresh ─────────────────────
else
  warn "Neither PM2 nor a systemd portivox service found."
  warn "Attempting to restart via PID file / pkill..."

  PIDFILE="${ROOT_DIR}/logs/gateway.pid"
  mkdir -p "${ROOT_DIR}/logs"

  # Kill the running process if it exists
  if [[ -f "$PIDFILE" ]]; then
    OLD_PID=$(cat "$PIDFILE")
    if kill -0 "$OLD_PID" 2>/dev/null; then
      kill -SIGTERM "$OLD_PID"
      # Wait up to 10s for graceful exit
      for _ in $(seq 1 10); do
        kill -0 "$OLD_PID" 2>/dev/null || break
        sleep 1
      done
      kill -0 "$OLD_PID" 2>/dev/null && kill -SIGKILL "$OLD_PID" || true
    fi
  fi

  # Start fresh in the background, capture PID
  LOG_OUT="${ROOT_DIR}/logs/gateway-out.log"
  LOG_ERR="${ROOT_DIR}/logs/gateway-err.log"
  nohup node apps/gateway-server/dist/index.js \
    >> "$LOG_OUT" 2>> "$LOG_ERR" &
  echo $! > "$PIDFILE"
  ok "Gateway started (PID $(cat "$PIDFILE")). Logs → logs/gateway-out.log"
  warn "Install PM2 for zero-downtime restarts: npm install -g pm2"
fi

# Step 7: Health-check ─────────────────────────────────────────────────────────
log "Waiting for gateway to become healthy..."
GATEWAY_PORT="${GATEWAY_PORT:-8080}"
RETRIES=20
until node -e "
  const h=require('node:http');
  const r=h.get('http://127.0.0.1:${GATEWAY_PORT}/healthz', res=>{
    process.exit(res.statusCode===200?0:1)
  });
  r.on('error',()=>process.exit(1));
  r.setTimeout(2000,()=>{r.destroy();process.exit(1);});
" 2>/dev/null; do
  RETRIES=$((RETRIES - 1))
  [[ $RETRIES -le 0 ]] && die "Gateway health-check timed out. Check logs."
  sleep 2
done

ok "Gateway is healthy on port ${GATEWAY_PORT}."
echo ""
echo -e "${GREEN}${BOLD}╔══════════════════════════════════════╗${NC}"
echo -e "${GREEN}${BOLD}║     Portivox deploy complete ✔       ║${NC}"
echo -e "${GREEN}${BOLD}╚══════════════════════════════════════╝${NC}"
