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

## Bootstrap the first security admin

No credentials are baked in; the operator names the first admin.

```sh
OPENFGA_API_URL=http://localhost:8081 \
  pnpm --filter @riz/scripts exec tsx src/cli.ts bootstrap-admin --admin <subject>
```

It creates the `riz-admin` store, writes and validates the model, writes the
`security_admin` tuple for `<subject>`, and prints:

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

- The API does not yet enforce the admin model on its routes (they still use token scopes,
  and registration does not write the parent tuple). Enforcement and the tuple write arrive
  with the audit, relationship and model-lifecycle endpoints (RIZ-020 to RIZ-022).
- Single organization, `organization:default`.
- Rotating `RIZ_ADMIN_MODEL_ID` is a manual, versioned step: write the new model, then
  change the variable.
