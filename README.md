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

## SDKs

Both SDKs are thin clients with the same behavior; `tests/conformance` holds the
cases they share. A check is made for an end user, whose verified token you pass
per call; the workload's own token is the client's `credentials`.

```ts
import { Riz } from "@riz/sdk";

const riz = new Riz({ baseUrl, credentials, application: "crm" });
const { allowed } = await riz.check({ action: "read", resource: "document:d1", endUserToken });
const { results } = await riz.batchCheck(
  [{ action: "read", resource: "document:d1" }, { action: "delete", resource: "document:d1" }],
  { endUserToken },
);
```

```python
async with Riz(base_url, credentials, "crm") as riz:
    decision = await riz.check(action="read", resource="document:d1", end_user_token=token)
    batch = await riz.batch_check([Check("read", "document:d1")], end_user_token=token)
```

An undecidable check never reads as an allow: `check` raises
`RizIndeterminateError`, and a batch item riz could not decide has status
`indeterminate` and `allowed` false. Treat any exception as a deny. The SDKs do
not retry, and they do not follow redirects.

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
