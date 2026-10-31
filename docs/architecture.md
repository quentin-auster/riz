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

Decisions are recorded in [docs/decisions](decisions/).
