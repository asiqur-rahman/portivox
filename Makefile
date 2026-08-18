# ─────────────────────────────────────────────────────────────────────────────
#  Portivox — Makefile
#
#  Stack management, build, and Docker Hub publish.
#
#  Services:  nginx · gateway · redis  (+ mysql in CasaOS)
#  Compose:   docker-compose.yml
# ─────────────────────────────────────────────────────────────────────────────

# ── Configuration ─────────────────────────────────────────────────────────────
DOCKER_USER    ?= asiqurrahman
TAG            ?= production
GIT_SHA        := $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)
GATEWAY_IMAGE  := $(DOCKER_USER)/portivox-gateway
NGINX_IMAGE    := $(DOCKER_USER)/portivox-nginx
DB_PROVIDER    ?= mysql

COMPOSE        := docker compose

.DEFAULT_GOAL := help

.PHONY: help up down restart rebuild logs \
        build clean push \
        migrate ps status

# ── Help ──────────────────────────────────────────────────────────────────────
help:
	@echo ""
	@echo "  Portivox — Docker targets"
	@echo "  ─────────────────────────────────────────────────────────"
	@echo ""
	@echo "  Stack"
	@echo "    make up              Start nginx + gateway + redis (build if needed)"
	@echo "    make down            Stop all containers (volumes kept)"
	@echo "    make restart         Restart all containers"
	@echo "    make rebuild         No-cache rebuild and recreate containers"
	@echo "    make ps              Show running containers"
	@echo "    make status          Show container status + ports"
	@echo "    make logs            Tail all container logs"
	@echo "    make logs s=gateway  Tail logs for a single service"
	@echo ""
	@echo "  Build"
	@echo "    make build           Build gateway + nginx images locally"
	@echo "    make clean           Stop stack, remove volumes + images"
	@echo ""
	@echo "  Push to Docker Hub"
	@echo "    make push            Interactive — shows last version, pick next"
	@echo "    make push VERSION=x.y.z  Non-interactive"
	@echo ""
	@echo "  Database"
	@echo "    make migrate         Run Prisma migrate deploy (inside gateway)"
	@echo ""
	@echo "  Images: $(GATEWAY_IMAGE)  $(NGINX_IMAGE)"
	@echo "  Git:    $(GIT_SHA)"
	@echo ""

# ── Stack ─────────────────────────────────────────────────────────────────────
up:
	$(COMPOSE) up -d --build

down:
	$(COMPOSE) down --remove-orphans

restart: down up

rebuild:
	$(COMPOSE) build --no-cache
	$(COMPOSE) up -d --force-recreate

logs:
ifdef s
	$(COMPOSE) logs -f $(s)
else
	$(COMPOSE) logs -f
endif

ps:
	$(COMPOSE) ps

status:
	$(COMPOSE) ps --format "table {{.Name}}\t{{.Service}}\t{{.Status}}\t{{.Ports}}"

# ── Build ─────────────────────────────────────────────────────────────────────
build:
	docker build -f apps/gateway-server/Dockerfile \
		--build-arg DB_PROVIDER=$(DB_PROVIDER) \
		-t $(GATEWAY_IMAGE):$(TAG) \
		-t $(GATEWAY_IMAGE):latest \
		-t $(GATEWAY_IMAGE):$(GIT_SHA) \
		.
	docker build -f infra/nginx/Dockerfile \
		-t $(NGINX_IMAGE):$(TAG) \
		-t $(NGINX_IMAGE):latest \
		-t $(NGINX_IMAGE):$(GIT_SHA) \
		.

# ── Clean ─────────────────────────────────────────────────────────────────────
clean:
	$(COMPOSE) down -v --remove-orphans
	-docker image rm -f \
		$(GATEWAY_IMAGE):$(TAG) $(GATEWAY_IMAGE):latest $(GATEWAY_IMAGE):$(GIT_SHA) \
		$(NGINX_IMAGE):$(TAG) $(NGINX_IMAGE):latest $(NGINX_IMAGE):$(GIT_SHA)
	-docker image prune -f

# ── Push (interactive version picker) ─────────────────────────────────────────
push:
	node ops/docker-push.mjs $(if $(VERSION),--version $(VERSION),)

# ── Database ──────────────────────────────────────────────────────────────────
migrate:
	$(COMPOSE) run --rm gateway node scripts/prisma-runner.cjs migrate deploy
