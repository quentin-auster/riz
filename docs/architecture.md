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

Decisions are recorded in [docs/decisions](decisions/).
