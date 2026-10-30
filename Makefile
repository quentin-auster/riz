COMPOSE = docker compose --env-file .env -f deploy/compose.yaml

.PHONY: install format lint typecheck test up down

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

up:
	$(COMPOSE) up --build -d

down:
	$(COMPOSE) down
