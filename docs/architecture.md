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

Decisions are recorded in [docs/decisions](decisions/).
