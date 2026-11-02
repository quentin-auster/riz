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
  The check is on the parsed model (duplicate type names), and it is enforced by this CLI
  only: anyone who can write to a store directly, or via `POST /v1/models`, bypasses it.

## Consequences and limits

- A change to the core is picked up by re-running `write-extension` for each application and
  rebinding; it is not applied automatically.
- Extensions only add to what the core grants. A Databricks (Unity Catalog) grant is still
  enforced natively and not mirrored into OpenFGA (ADR 0007), so an application can narrow
  access beyond it but not widen it.
- **The core is not enforced anywhere server-side.** `POST /v1/models` and `pnpm model write`
  take a complete DSL document and its own assertions (ADR 0005); neither composes nor
  checks the core, so an application that skips `write-extension` can redefine a central
  role. The guarantee holds only for models written through this CLI. Composing in the API
  is the follow-up that delivers it. shortcut: have the API compose server-side if
  applications are to submit extensions without the CLI.
- A suite must test the composed model: an extension tests file that sets an inline `model:`
  is rejected, because the `fga` CLI would test that model instead of the composed one.
- If the core gains a type whose name an application already uses, that application's
  extension fails to compose until it renames the type. Nothing warns owners in advance.
- `base.fga` is unchanged and remains the starter model.
