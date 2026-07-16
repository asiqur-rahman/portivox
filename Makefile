# Portivox / Tunnelix — Docker Compose lifecycle
#
#   make up        Start (or refresh) the stack; build if needed
#   make rebuild   Force no-cache image rebuild, then recreate containers
#   make down      Stop and remove containers; keep volumes (Redis data)
#   make down-v    Stop and remove containers + volumes (wipes redis_data)
#
# Optional:
#   make logs      Follow compose logs
#   make migrate   Run Prisma migrate deploy inside the gateway container
#   make ps        Show container status

.PHONY: up rebuild down down-v logs migrate ps

up:
	docker compose up -d --build

rebuild:
	docker compose build --no-cache
	docker compose up -d --force-recreate

down:
	docker compose down --remove-orphans

down-v:
	docker compose down --remove-orphans --volumes

logs:
	docker compose logs -f

migrate:
	docker compose run --rm gateway node scripts/prisma-runner.cjs migrate deploy

ps:
	docker compose ps
