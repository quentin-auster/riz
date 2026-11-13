# Threat model

riz decides whether a caller may do something, so the main harm is a wrong **allow**. This
page lists what is protected, where trust changes hands, how the system fails, and which
test backs each mitigation. A threat with no test is listed under [Not mitigated](#not-mitigated-or-unverified).

## Assets

| Asset | Why it matters |
| --- | --- |
| Decisions | An allow that OpenFGA did not give is a breach. |
| Tuples and models | Per-application OpenFGA stores; changing them changes who gets in. |
| Workload bindings | Decide which applications a workload may check. |
| Audit log | Evidence of every mutation; must not be bypassed or forged. |
| Credentials | Workload and end-user tokens, admin tokens, database and OpenFGA passwords, Databricks user tokens. None may be logged or stored by riz. |

## Trust boundaries

1. **Workload or SDK to API.** Everything a caller sends is untrusted until a token is
   verified. TLS is terminated outside riz.
2. **Browser to console to API.** The console holds the session; the API still authorizes every call.
3. **API to OpenFGA** and **API to Postgres.** Trusted, but may be down, slow or partitioned.
4. **API to the identity provider's key set.** Fetched over https (http only for localhost).
5. **SDK to Databricks.** The user's own token goes straight to Databricks, never through riz.

Out of scope: a compromised identity provider, platform administrator, or host running
Postgres or OpenFGA; supply-chain compromise (reviewed with the release milestone).

## Fail closed

- **No decision means no allow.** A timeout, a refused or reset connection, an unreachable
  database, and a failed or missing batch item all answer `indeterminate` (`timeout`,
  `backend_error`). An application with no active model answers `no_active_model`, but no
  test covers that path yet. The SDKs raise `RizIndeterminateError`
  and never resolve to allow.
- **Mutations fail whole.** An unreachable OpenFGA is a 503 and leaves no audit event; a
  mutation whose audit write fails is rolled back.
- **Authentication errors are not outages.** An unreachable key set throws, so the request
  fails; it is never treated as "token valid".
- **Startup refuses unsafe configuration.** No `RIZ_AUTH_MODE`, or fixture authentication
  with `NODE_ENV=production`, stops the process.
- **Scope and allow-list are decided before the application is looked up**, so a 403 does
  not reveal whether an application exists.

### Replicas do not fall back

Replicas hold no decision state ([ADR 0009](decisions/0009-multi-replica.md)). A replica
that loses OpenFGA or Postgres answers `indeterminate` for itself and fails readiness so
the load balancer drains it. It does not ask another replica, serve a cached decision, or
use a local copy of the tuples. riz has no decision cache (RIZ-036 was not built), so there
is nothing stale to serve. Staleness comes only from OpenFGA's own caches, and
`higher_consistency` bypasses them ([architecture](architecture.md#revocation-freshness)).

## Threats

Paths are relative to the repository root. `tests/security/` runs the real API process.

### T1 Identity spoofing

*A caller claims an identity it does not hold.* Mitigation: identities come only from verified
tokens (signature, issuer, audience, expiry); only asymmetric algorithms are accepted; a user
named in a header or body is ignored or rejected ([ADR 0003](decisions/0003-end-user-delegation.md)).

- `tests/security/identity.test.ts`: forged headers and body; for the workload token and the
  end-user token alike, `alg: none`, HS256, an unpublished signing key, wrong audience, wrong
  issuer, expired, not yet valid, no expiry, not a JWT; fixture auth refused in production;
  startup refused with no mode.
- `apps/api/src/auth/oidc.test.ts`, `fixture.test.ts`, `server.test.ts` ("v1 routes return 401 without a valid bearer token").

### T2 Delegation abuse

*A workload checks as a user it should not, or an unbound workload checks at all.* Mitigation:
the end-user token's `azp` must equal the calling workload; the workload must be bound to the application.

- `tests/security/identity.test.ts`: replayed user token (other `azp`, no `azp`); unbound workload 403; unbinding takes effect on the next check.
- `apps/api/src/auth/delegation.test.ts`, `apps/api/src/checks/check.test.ts` ("a workload not bound to the application gets 403, whether or not it exists").

### T3 Cross-tenant access

*Application A reads or influences application B.* Mitigation: one OpenFGA store per
application; store and model IDs are resolved server-side and the contract has no field for them ([ADR 0001](decisions/0001-store-isolation.md)).

- `tests/security/isolation.test.ts`: identical tuples in A invisible to B; a token scoped to A refused on B for check, batch, relationships and models; `storeId`/`modelId` fields rejected and the same values in headers or query ignored.
- `apps/api/src/admin/admin.test.ts` ("registering two applications yields distinct stores and bindings"), `apps/api/tests/integration/api.test.ts`.

### T4 Admin escalation

*A check-only workload or an application administrator gains platform rights.* Mitigation:
exact scope names, a per-application allow-list, `*` required to register applications or change bindings, and least-privilege OIDC workloads (`check` only).

- `tests/security/isolation.test.ts`: look-alike scopes (`relationships:*`, `*`, `admin`) and read-only tokens cannot write; an application admin cannot register applications, bind workloads or write to another application, and organization tuples it writes affect only its own application.
- `apps/api/src/auth/workloads.test.ts` ("only a platform administrator with bindings:write can change bindings"), `apps/api/src/admin/relationships.test.ts`, `apps/api/src/admin/authorizer.test.ts`.

### T5 Model tampering

*A bad or hostile model changes decisions.* Mitigation: models go through `POST /v1/models`,
which proves the caller's assertions in a scratch store first, then binds a new immutable
model in one audited transaction; requests never resolve "latest" ([ADR 0005](decisions/0005-model-lifecycle.md), [0002](decisions/0002-model-pinning.md)).

- `tests/security/migration.test.ts`: unparseable and unfitting models rejected; failing assertions never bind; allow-only or deny-only assertions refused; rollback restores decisions; a model for A never moves B; B's model cannot be rolled back into A; a newer model written straight to the store is ignored.
- `apps/api/src/admin/models.test.ts`; `make model-test` for the shipped models.

### T6 Outages and stale allows

*A dependency fails, or a revoked grant is still honoured.* Mitigation: the fail-closed rules above, and `higher_consistency` where staleness is unacceptable.

- `tests/security/outage.test.ts`: OpenFGA down, OpenFGA unresponsive, Postgres down, both down; zero allows, bounded time, recovery. A network partition between a replica and OpenFGA is the same fault as "down".
- `tests/security/revocation.test.ts`: grant, check, revoke, check in each mode.
- Partial batch failure: `apps/api/src/checks/check.test.ts` ("a failed or missing batch item is indeterminate without affecting the others"). SDKs: `tests/conformance/cases/*indeterminate*.json`, run by both SDKs.
- `apps/api/src/health.test.ts`, `authorizer.test.ts` ("an unreachable OpenFGA is a 503, never an allow").

### T7 Log and error leakage

*Tokens or protected data reach logs, errors or storage.* Mitigation: request logs hold the
path only; `redact` masks credential keys and bearer text; errors never echo credentials.

- `tests/security/identity.test.ts` ("no presented token appears in the API's logs"), `apps/api/src/server.test.ts` ("a bearer token never appears in log output").
- `sdks/typescript/src/leak.test.ts`, `sdks/python/tests/test_leak.py`; `apps/api/src/auth/fixture.test.ts` ("a malformed fixture file is rejected without echoing its contents").

### T8 Databricks credential misuse

*A service credential is used where the user's was required, or the user's token goes elsewhere.* Mitigation: user-delegated tokens only; no fallback to another header, a service principal or an empty result; the workspace host is a bare https host name; no redirect is followed; riz stores no credentials ([ADR 0007](decisions/0007-databricks-provider.md)).

- `sdks/typescript/src/databricks.test.ts` and `sdks/python/tests/test_databricks.py`: refuses without a user token, no fallback, no redirect, unsafe hosts rejected, transport errors carry no token, a user without a grant is denied.
- `apps/api/src/providers/providers.test.ts` ("credentials, URLs and unknown fields are refused and nothing is stored").

## Not mitigated or unverified

- **Admin routes follow organization roles in the riz-admin store only** ([ADR 0004](decisions/0004-admin-authorization.md)) when `RIZ_AUTH_MODE=oidc`. Application-level admin roles are not enforced yet, and an admin role belongs to a client and applies only to tokens carrying the issuer's `adminAudience`, so keep that audience out of user logins.
- **A user token stays valid until `exp`** ([ADR 0003](decisions/0003-end-user-delegation.md)); a workload can present its own token as the user token and then checks as itself. Short token lifetimes are the control.
- **OpenFGA's default consistency can be stale**; no test asserts how stale because it depends on its cache settings.
- **The `higher_consistency` tests are weak on an uncached OpenFGA.** CI's OpenFGA has no check cache, so `revocation.test.ts` would still pass if riz stopped forwarding the consistency option. It proves the end-to-end answer, not that the option is forwarded.
- **A timed-out OpenFGA request is abandoned, not cancelled**, so a slow OpenFGA still receives the work.
- **No rate limiting** and no shared state to hold one across replicas.
- **The API image runs as root and does not handle SIGTERM**; the Kubernetes manifests assume uid 1000. Console sessions are in memory ([ADR 0006](decisions/0006-console-session.md)).
- **Unverified against real infrastructure:** a real identity provider (the tests use a local issuer), a real Databricks workspace (`test_unverified_real_unity_catalog_denies_a_user_without_a_grant` is skipped), console login against a real IdP, and applying the Kubernetes manifests to a cluster.
- **The fault injection is a TCP proxy** in the test process, not a compose profile. It cuts or blackholes connections but does not model a database that answers wrongly.

## Running the security suite

With Postgres and OpenFGA reachable (CI uses a Postgres service and an in-memory OpenFGA):

```
RIZ_DATABASE_URL=postgres://... OPENFGA_API_URL=http://localhost:8081 \
  pnpm --filter @riz/security test:security
```

Each file starts the API from `apps/api/src` as a child process, so the production wiring is what is tested.
