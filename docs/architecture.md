# Architecture

riz is an organization-wide authorization control plane. It does not evaluate
policy itself; OpenFGA does.

```
SDK (Python / TypeScript) --HTTP--> riz API --> OpenFGA --> PostgreSQL (openfga db)
                                        |
                                        +-----> PostgreSQL (riz db, separate role)
Console (SvelteKit) --HTTP--> riz API
```

- The SDKs are thin clients of the riz API.
- The API resolves store and model IDs server-side; callers never supply them.
- OpenFGA and riz use separate databases and credentials.

Each application gets its own OpenFGA store, and inheritance does not cross
stores. See [ADR 0001: store isolation](decisions/0001-store-isolation.md).

## Components

| Part | Role | State |
| --- | --- | --- |
| `apps/api` | The HTTP API (`/v1`): checks, applications, relationships, models, audit, providers. Authenticates callers, resolves the store and pinned model, calls OpenFGA. | None; replicas are interchangeable ([ADR 0009](decisions/0009-multi-replica.md)). |
| `apps/console` | Administrative UI. A client of the API; it holds the login session and nothing else ([ADR 0006](decisions/0006-console-session.md)). | In-memory sessions, so one replica. |
| `sdks/python`, `sdks/typescript` | Thin clients for `check` and `batch check`. | None. |
| OpenFGA | Evaluates policy. One store per application plus a `riz-admin` store. | Its own Postgres database. |
| PostgreSQL (`riz` database) | Applications, model bindings, workload bindings, audit events. | Yes; see [operations](operations.md#backup-and-restore). |
| `models/openfga` | Version-controlled base and admin models, with tests. | Source files. |
| `contracts` | The OpenAPI contract the API, SDKs and conformance tests share. | Source files. |

## A check, end to end

1. A workload calls `POST /v1/check` with its own token and the end user's token in
   `riz-end-user-token`. The user is never taken from the request body
   ([ADR 0003](decisions/0003-end-user-delegation.md)).
2. The API verifies both tokens, confirms the workload may check this application, and looks
   up the application's store and **pinned** model ([ADR 0002](decisions/0002-model-pinning.md)).
3. It asks OpenFGA, with the caller's `consistency` choice, and answers `allow` or `deny`.
   If OpenFGA or Postgres cannot answer, the decision is `indeterminate` (never an allow);
   the HTTP status is still 200. Authentication failures are errors, not decisions.

Mutations are authorized by token scope, and each writes an audit event in a Postgres
transaction. A model change and its audit event commit together
([ADR 0005](decisions/0005-model-lifecycle.md)). A relationship write inserts the audit row
first, so an audit failure blocks the change; if the commit fails after OpenFGA accepted the
write, the change is left unaudited (see `apps/api/src/admin/relationships.ts`).

## Data providers

Providers such as Databricks keep their own authorization. riz stores only an application's
connection settings, never the source system's grants; the user's own token goes to the
source ([ADR 0007](decisions/0007-databricks-provider.md)).

## Revocation freshness

A check and a batch check take an optional `consistency`, passed to OpenFGA as is:

| Mode | Guarantee after a relationship is revoked |
| --- | --- |
| `minimize_latency` (default; also used when `consistency` is omitted) | None beyond OpenFGA's own. The answer may come from OpenFGA's caches, so a revoked relationship can still be allowed until the cached entry expires. How long that is depends on the OpenFGA deployment's cache settings, not on riz. |
| `higher_consistency` | The check is evaluated against the latest committed writes, so a revocation already acknowledged by OpenFGA is seen. It costs more latency and datastore load. |

riz adds no cache of its own. Use `higher_consistency` where a stale allow is
unacceptable (for example, before a destructive action) and the default
elsewhere. A batch applies one mode to every check in it. An outage is still
`indeterminate` in both modes, never an allow.

The integration test `higher_consistency denies a user whose access was just
revoked` covers the strong mode against a real OpenFGA. The staleness of the
default mode depends on OpenFGA's cache configuration, so no test asserts it.

Decisions are indexed in [docs/decisions](decisions/README.md). For running riz see
[operations](operations.md); for what it defends against, [security](security.md).
