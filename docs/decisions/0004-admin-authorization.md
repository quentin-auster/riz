# 0004 — Authorizing riz's own administration

## Decision

Administrative actions (register an application, manage workload bindings, read audit,
manage relationships and models) are authorized by OpenFGA in a dedicated **`riz-admin`
store**, separate from every application store. Check permission (`check` scope, an
application's own store) never implies any admin permission.

The model is `models/openfga/riz-admin.fga`; its assertions are `riz-admin.tests.yaml`
(`make model-test`). Roles:

| Role | Granted by tuple | Can |
| --- | --- | --- |
| security admin | `user:<sub> security_admin organization:default` | everything, on every application |
| auditor | `user:<sub> auditor organization:default` | read applications and audit, mutate nothing |
| application admin | `user:<sub> admin application:<id>` | read, manage relationships and model of that application only |

The API evaluates these through `createAdminAuthorizer` (`apps/api/src/admin/authorizer.ts`)
at a **pinned model ID** (`RIZ_ADMIN_MODEL_ID`, never "latest"). An OpenFGA outage is a
503 `authorization_unavailable`; a subject that is not a plain identifier is denied.

## How it reaches the routes (`RIZ_AUTH_MODE=oidc`)

The routes keep checking scopes and the application allow-list. In oidc mode, for every
request that is not a check, `withAdminScopes` (`apps/api/src/admin/elevate.ts`) adds the
scopes the caller's **organization** roles carry and widens its allow-list to all
applications:

| Role | Scopes added |
| --- | --- |
| security admin | every admin scope (applications, models, relationships, bindings, audit, providers, explorer) |
| auditor | `applications:read`, `models:read`, `audit:read` |
| none, or application admin only | none: the workload keeps `check` on its bound applications and nothing else |

**Only an admin token is elevated.** A client ID alone cannot tell a service account from a
person signing in through the same client, so the issuer entry in `RIZ_OIDC_ISSUERS` takes
an `adminAudience`, distinct from `audience`. A token is elevated only if it carries that
audience, and with no `adminAudience` configured nothing is ever elevated. Configure the IdP
to put it in tokens for the service accounts that administer riz, and never in user logins.
A token with the admin audience but no role in the store gets nothing.

Check requests are decided first and with the principal as authenticated, so the check
path never waits on the admin store and an admin's reach never carries over to it. The API
refuses to start in oidc mode without `RIZ_ADMIN_STORE_ID` and `RIZ_ADMIN_MODEL_ID`.

A workload's name in the admin store is the SHA-256 (hex) of the JSON array
`[issuer, workload]`. The raw pair holds `:` and `/`, which an OpenFGA user ID cannot, and
hashing keeps two issuers that issue the same client ID apart; JSON keeps a `|` in either
value from making two pairs collide. The bootstrap command computes it. Only paths under
`/v1/me`, `applications`, `audit`, `models`, `providers`, `relationships`,
`workload-bindings` and `explorer` ask the admin store; unknown paths do not.

## Bootstrap the first security admin

No credentials are baked in; the operator names the first admin workload.

```sh
OPENFGA_API_URL=http://localhost:8081 \
  pnpm --filter @riz/scripts exec tsx src/cli.ts bootstrap-admin \
  --issuer <issuer> --workload <client id>
```

`--admin <subject>` names a subject directly instead (a plain identifier, such as an
already-computed hash). The command creates the `riz-admin` store, writes and validates the model, writes the
`security_admin` tuple for that workload, and prints:

```
RIZ_ADMIN_STORE_ID=...
RIZ_ADMIN_MODEL_ID=...
```

Set both in the API's environment. It refuses to run when a `riz-admin` store already
exists. To grant further roles afterwards, write tuples to that store (table above) with
the OpenFGA CLI or API.

Every application needs a parent tuple `organization:default organization application:<id>`
in the admin store for org-level roles to reach it.

## Limitations

- Only organization roles are enforced. An application admin (`admin application:<id>`) gets
  no admin scopes, because scopes are global and could not keep it to its own application
  (an application admin who was also an auditor would write everywhere). Enforcing it needs a
  per-route, per-application check, and registration must then write the parent tuple.
- Each admin request makes three checks against the admin store, in parallel. Fine for
  administrative traffic; cache them if that ever changes.
- Single organization, `organization:default`.
- Rotating `RIZ_ADMIN_MODEL_ID` is a manual, versioned step: write the new model, then
  change the variable.
