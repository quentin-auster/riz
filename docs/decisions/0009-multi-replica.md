# 0009 — Multi-replica deployment

## Decision

API replicas are interchangeable. They share only Postgres (applications, models, bindings,
audit) and OpenFGA (tuples), and hold no durable local state, so any number can run behind
a plain load balancer with no stickiness.

## The check that keeps it true

- `apps/api/src/stateless.test.ts` fails if API source imports anything from the filesystem
  other than `readFileSync` and `readdirSync`. The API reads files it ships with (the base
  model, migrations, fixture auth) and never writes.
- In-memory state is limited to derived, rebuildable data: the OIDC public key set (cached
  by `jose`, refetched on an unknown key ID) and the OpenFGA client per request. Nothing a
  second replica would need to see.
- Concurrent start-up is safe: migrations are serialized by a Postgres advisory lock.

## The equivalence test

`tests/load/equivalence.test.ts` sends the same request set (allow, deny, batch, 401, 404)
repeatedly through a load balancer and asserts every replica returns the same status and
body (apart from the per-request `requestId`), and that responses came from at least
`RIZ_REPLICAS` distinct replicas. The compose `replicas` profile provides it: N
`api-replica` containers behind nginx, which tags each response with `X-Riz-Replica`. CI
runs it in the `replicas` job.

```
docker compose --profile replicas up -d --build --wait lb
RIZ_LB_URL=http://localhost:8090 pnpm --filter @riz/api test:replicas
```

## Consequences and limits

- The test was run locally against two API processes behind a stand-in round-robin proxy.
  The compose profile and nginx config were validated with `docker compose config` only;
  running them in containers is **unverified** until CI runs the `replicas` job.
- nginx resolves replica addresses once at start: restart `lb` after changing
  `RIZ_REPLICAS`. shortcut: use a real load balancer or service discovery in production.
- Rate limits, if added later, would need shared state to hold across replicas.
