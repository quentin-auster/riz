# 0011 — Core model and application extensions

## Decision

An application's model is the riz **core** (`models/openfga/core.fga`: `user`,
`organization`, `application`) plus an application-owned **extension** (types only, for
example `models/openfga/apps/crm/extension.fga`). Applications add finer-grained roles and
resources in the extension and build them on core roles (`admin from organization`).

- `pnpm model validate-extension <extension.fga>` composes core + extension and runs both
  suites (`core.tests.yaml`, `<extension>.tests.yaml`) against the composed model.
- `pnpm model write-extension <extension.fga> --store-id <id>` does the same, then writes the
  composed model (a new immutable ID, ADR 0002).
- An extension may reference core types but **cannot redeclare them** and carries no `model`
  header, so it cannot change what a central role means. The core suite must still pass.
  The check is on the parsed model (duplicate type names).
- **The API enforces the core on every model submission.** `POST /v1/models` takes either
  `extension` (types only, composed after the core server-side) or a complete `model`. Either
  way the parsed result must contain each core type exactly once and unchanged, or the request
  is refused with 422 `core_violation` and nothing is written or bound. Because core types
  reference only core types, an unchanged core type decides exactly as before whatever else
  the model adds. The API loads `models/openfga/core.fga` at startup; the check is off only
  when no core is configured (tests).
- The governance line: applications are free to add any types, relations and roles, and to
  build them on core roles; they cannot add, remove or alter anything the core defines.

## Consequences and limits

- A change to the core is picked up by re-submitting each application's extension; it is not
  applied automatically, and an existing binding keeps the model it was bound with. The core
  is read when the API starts, so a core change needs a restart.
- **Rollback is governed too.** `POST /v1/models/rollback` re-reads the stored model and
  applies the same core check, so a model bound before the guard existed, or under an older
  core, cannot be restored (422 `core_violation`). Such a model that is already active stays
  active; nothing reports them. shortcut: add a report of bound models that fail the check.
- The core may not reference non-core types. If it ever does, the equality check no longer
  proves the core's decisions are unchanged, and the check must be revisited.
- Extensions only add to what the core grants. A Databricks (Unity Catalog) grant is still
  enforced natively and not mirrored into OpenFGA (ADR 0007), so an application can narrow
  access beyond it but not widen it.
- **Writing straight to an OpenFGA store, or `pnpm model write`, bypasses the API check.** Only
  models submitted through `POST /v1/models` are governed; and only a *bound* model is ever
  used (ADR 0002), so an unbound model written around the API is inert. Keep OpenFGA
  credentials away from application teams. The binding itself is only changed by the API.
- The server checks core types for equality; it does not re-run `core.tests.yaml`. The CLI
  still runs both suites as developer feedback. shortcut: share one implementation between
  the CLI and the API if the two checks drift.
- The API requires `models:write` and the application allow-list (ADR 0005), and every bind
  is audited, so an extension reaches an application only through an authorized,
  audited request.
- A suite must test the composed model: an extension tests file that sets an inline `model:`
  is rejected, because the `fga` CLI would test that model instead of the composed one.
- If the core gains a type whose name an application already uses, that application's
  extension fails to compose until it renames the type. Nothing warns owners in advance.
- `base.fga` is unchanged and remains the starter model.
