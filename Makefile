COMPOSE = docker compose --env-file .env -f deploy/compose.yaml

FGA_CLI = openfga/cli:v0.8.2

.PHONY: install format lint typecheck test model-test up down

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

up:
	$(COMPOSE) up --build -d

down:
	$(COMPOSE) down
