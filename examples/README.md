# Examples

One small service per integration path. Each asks riz whether the calling user may read a
document, and refuses when riz says no or cannot say.

| Example | Stack |
| --- | --- |
| [`fastapi`](fastapi/README.md) | Python SDK, FastAPI |
| [`express`](express/README.md) | TypeScript SDK, Express |
| [`databricks`](databricks/README.md) | Python SDK plus Unity Catalog (needs a real workspace) |

## Setup (fastapi and express)

Requires Docker, Node 22+, pnpm 10 and uv. From the repo root:

```sh
cp .env.example .env     # then replace the placeholder passwords
make up                  # postgres, openfga, api on :8080
export RIZ_API_URL=http://localhost:8080 RIZ_WORKLOAD_TOKEN=dev-check-token
export RIZ_APPLICATION=$(examples/seed.sh)
```

`seed.sh` registers an application in which the user behind `dev-alice-token` can read
`document:d1` and nothing else. The tokens are the dev-only fixtures in `deploy/fixtures`;
a real deployment uses real end-user tokens and a workload credential issued by riz.

Then run an example from its README. Stop the stack with `make down`.

## Smoke test

`examples/smoke.sh` runs the setup above, starts both examples and checks four outcomes
for each: allowed (200), denied (403), no token (401), unknown token (401). CI runs it in the
`examples` job. The Databricks example is not part of it.
