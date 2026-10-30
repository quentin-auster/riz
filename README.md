# riz

Organization-wide authorization control plane built on [OpenFGA](https://openfga.dev).
See [docs/architecture.md](docs/architecture.md) and [AGENTS.md](AGENTS.md).

## Quickstart

Requires Node 22+, pnpm 10, uv, and Docker.

```sh
cp .env.example .env     # then replace the placeholder passwords
make install
make test
make up                  # postgres, openfga, api (:8080), console (:3000)
curl localhost:8080/health/live
make down
```

## Layout

| Path | Purpose |
|------|---------|
| `apps/api` | Central HTTP API (TypeScript, Node) |
| `apps/console` | SvelteKit administration console |
| `sdks/python`, `sdks/typescript` | Client SDKs |
| `models/openfga` | Version-controlled authorization models |
| `contracts` | Shared API contracts |
| `deploy` | Docker Compose and deployment config |
| `docs/decisions` | Architecture decision records |
