COMPOSE = docker compose --env-file .env -f deploy/compose.yaml

FGA_CLI = openfga/cli:v0.8.2

.PHONY: install format lint typecheck test model-test migrate integration up down

install:
	pnpm install --frozen-lockfile
	uv sync --frozen

format:
	pnpm format
	uv run ruff format .

lint:
	pnpm lint
	uv run ruff check .

typecheck:
	pnpm typecheck
	uv run mypy sdks/python/src

test:
	pnpm test
	uv run pytest sdks/python

model-test:
	docker run --rm -v "$(CURDIR)/models/openfga:/models:ro" $(FGA_CLI) model test --tests /models/tests.yaml

# Needs RIZ_DATABASE_URL (see .env.example) and `make up` Postgres running.
migrate:
	pnpm --filter @riz/api migrate

# Black-box API tests against the compose stack; needs `make up` first.
integration:
	RIZ_API_URL=http://localhost:8080 OPENFGA_API_URL=http://localhost:8081 pnpm --filter @riz/api test:integration

up:
	$(COMPOSE) up --build -d --wait

down:
	$(COMPOSE) down
