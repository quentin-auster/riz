# Operations

What to run, how to scale it, and what to do when something goes wrong. For what the
system defends against, see [security.md](security.md); for how it is built,
[architecture.md](architecture.md).

**Status of this page.** The commands and endpoints below are the ones in the repository.
Nothing here was exercised against a production-like deployment: the Kubernetes manifests
are schema-checked only, and the backup and restore steps have not been run. Treat
those parts as a plan to rehearse, not a tested procedure.

## Deploy

riz needs two things it does not manage: **PostgreSQL** and **OpenFGA** (backed by
Postgres). The API (`riz-api`) and console (`riz-console`) are the only riz processes.

| Target | How | Notes |
| --- | --- | --- |
| Local | `make up` (Docker Compose: postgres, openfga, api `:8080`, console `:3000`) | Fixture authentication and dev-only tokens; never expose it. |
| Kubernetes | `deploy/kubernetes/` ([README](../deploy/kubernetes/README.md)) | Edit the placeholder ConfigMap values, create the two secrets, then apply. |

**Admin endpoints are not reachable in production yet.** Under `RIZ_AUTH_MODE=oidc` every
token receives only the `check` scope, so the administrative endpoints (applications,
relationships, models, workload bindings, audit) return 403; only fixture authentication
grants admin scopes ([ADR 0004](decisions/0004-admin-authorization.md),
[ADR 0006](decisions/0006-console-session.md)). The procedures below that call those
endpoints describe the API, but cannot be run against an `oidc` deployment today.

The main environment variables of the API:

| Variable | Meaning |
| --- | --- |
| `RIZ_DATABASE_URL` | Postgres URL for the `riz` database (a separate role from OpenFGA's). Required. |
| `OPENFGA_API_URL` | OpenFGA base URL. Required. |
| `RIZ_AUTH_MODE` | Required: `oidc` for production, `fixture` for local only. Fixture mode with `NODE_ENV=production` stops the process; the image defaults to production. |
| `RIZ_OIDC_ISSUERS` | Required for `oidc`: a JSON array of `{issuer, audience, jwksUri}`. |
| `RIZ_FIXTURE_AUTH_FILE`, `RIZ_FIXTURE_END_USERS_FILE` | Fixture mode only: the dev token files. |
| `RIZ_CHECK_TIMEOUT_MS`, `RIZ_BATCH_MAX`, `RIZ_READY_TIMEOUT_MS` | Check deadline, batch size cap, readiness probe deadline. |
| `PORT` | Listen port. |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `RIZ_METRICS_PORT`, `RIZ_METRICS_HOST` | Optional tracing and metrics ([ADR 0008](decisions/0008-observability.md)). The metrics port is unauthenticated: keep it on the monitoring network. |

Terminate TLS in front of the API. Release images are built, signed and verified as
described in [versioning.md](versioning.md); pull by digest or verify the signature before
deploying.

The first replica to start applies database migrations under an advisory lock, so replicas
may start together. To migrate before sending traffic: `pnpm --filter @riz/api migrate`.

## Scale

API replicas are interchangeable and hold no state ([ADR 0009](decisions/0009-multi-replica.md)):
add replicas behind a plain load balancer, no stickiness. The Kubernetes manifests start
two and include an example HPA (needs metrics-server). Health routes:

- `/health/live`: process is up; no dependencies. Restart on failure.
- `/health/ready`: Postgres and OpenFGA reachable. Remove from the load balancer on
  failure; do not restart.

The console is **one replica**: its sessions are in memory ([ADR 0006](decisions/0006-console-session.md)).
Throughput is bounded mainly by OpenFGA and Postgres, not by the API; see
[load-test-report.md](load-test-report.md) for what was measured and on what.

## Backup and restore

State lives in two Postgres databases, and both are needed:

| Database | Holds | Lost means |
| --- | --- | --- |
| `riz` | applications, model bindings, workload bindings, audit events | Applications unknown; no history of who changed what. |
| `openfga` | every application's store (tuples, models), plus the `riz-admin` store | All relationships gone, and the `riz-admin` store with them. Checks return `indeterminate` while the store is missing or OpenFGA is down. |

The two refer to each other (a `riz` application row names an OpenFGA store), so back them
up together, at the same point in time where you can (for example a snapshot of the
Postgres instance, or `pg_dump` of both taken back to back with writes paused). Restore both
from the same moment; a restored `riz` database pointing at a newer or older `openfga`
database can name stores that do not exist or hide recent grants and revocations.

Nothing else needs backing up: replicas are stateless, and the compose dev stack is
disposable. Secrets (database URL, OIDC client secret) live in your secret store.

After a restore, take a revocation into account: anything revoked since the backup is
**granted again**. Re-apply those revocations (the audit log in the restored database ends at
the backup point) before sending traffic.

## Model migration

Change an application's authorization model only through `POST /v1/models`
([ADR 0005](decisions/0005-model-lifecycle.md)). The request carries the model and
assertions (at least one allow and one deny); riz loads it into a scratch store, checks
every assertion, and only then binds it, in one transaction with an audit event
(`models.bind`).

Before submitting:

1. Check the model in the repository's tests (`make model-test` for riz's own models).
2. Write assertions for the access that must *not* change as well as the new access.
   Tuples already in the application's store are not re-validated: a model that drops a
   relation silently stops honouring the tuples that used it, and only your assertions
   guard against that.
3. Submit, then confirm with `GET /v1/models?application=<id>` that the new model is active.

Callers are never bound to "latest": a request resolves to the application's pinned model,
so a half-finished migration is not visible to checks.

## Rollback

**A model.** `POST /v1/models/rollback` re-binds a model the application was bound to
before (`models.rollback` in the audit log). A model riz never bound to that application
cannot be restored. Rolling back changes decisions immediately for every caller.

**A release.** Redeploy the previous image tag or digest. Database migrations are
forward-only SQL files with no down scripts, so rolling the API back leaves the newer
schema in place. Read the newer release's migrations (`apps/api/migrations/`) before downgrading; an older API on a newer schema is untested.
When in doubt, restore the pre-upgrade database backup instead.

**Relationships.** A mistaken grant or revocation is fixed by writing or deleting the tuple
(`POST` / `DELETE /v1/relationships`); both are audited. There is no bulk undo; use the
audit log to see exactly what changed.

## Incident response

Start with what callers are seeing, because riz is built to fail closed:

| Symptom | Meaning | First step |
| --- | --- | --- |
| Checks return `indeterminate` (SDK `RizIndeterminateError`), `/health/ready` failing | OpenFGA or Postgres is unreachable or slow. Nobody is allowed; nobody is wrongly allowed either. | Restore OpenFGA / Postgres. Replicas recover on their own. |
| Authentication failing for every user (401 or an error) | The identity provider's key set is unreachable, or its issuer or keys changed. An unreachable key set fails the request; it is never read as "token valid". | Check `RIZ_OIDC_ISSUERS` and that the API can reach the key set. |
| 401 or 403 from one workload | Bad workload credential, or no workload binding for this application (403 with an empty `applications` list). | `GET /v1/me` with its token to see its scopes and applications; `POST /v1/workload-bindings` if a binding is missing. |
| A user keeps access after revocation | Default `minimize_latency` reads may be served from OpenFGA's caches. An end-user token issued before the revocation stays valid until its `exp` ([ADR 0003](decisions/0003-end-user-delegation.md)); keep those lifetimes short. | Check with `consistency: higher_consistency`; see [architecture](architecture.md#revocation-freshness). |

**Suspected credential leak (workload token).** Remove its access first, investigate second:
`DELETE /v1/workload-bindings` for each application it was bound to, then rotate the token at
the identity provider. Review its scopes with `GET /v1/me`: a token holding only `check`
can read decisions but not change permissions (admin actions need separate scopes,
[ADR 0004](decisions/0004-admin-authorization.md)).

**Suspected unauthorised change.** `GET /v1/audit?application=<id>&from=<time>` (filters:
`actor`, `action`, `from`, `to`; newest first) shows who changed relationships, models and
bindings (model changes record the before and after model IDs). Reverse a bad change as under Rollback, then rotate the
credential that made it (the `actor` in the event).

**Always capture** the `requestId` from the error or response; it joins the API log, the
trace (when enabled) and the audit event. Do not paste tokens into tickets; riz does not log
them, and neither should you.

## Known gaps

- Backup, restore, rollback and incident steps are unrehearsed.
- No stale-store janitor: a failed scratch-store delete leaves an inert `riz-validate-*`
  store in OpenFGA ([ADR 0005](decisions/0005-model-lifecycle.md)); remove it by hand.
- No built-in alerting; the metrics in [ADR 0008](decisions/0008-observability.md) are the
  inputs. The suggested starting alerts are `/health/ready` failing, and a rising share of
  `riz.check.decisions{status="indeterminate"}`.
