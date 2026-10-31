# 0007 — Databricks as a data provider

## Decision

Unity Catalog stays the only authority over Databricks data. riz decides whether an
*application* may offer a feature; Databricks decides what a *user* may read.

1. **User-delegated credentials only.** A query runs with the end user's own token: the
   token Databricks Apps forwards for the signed-in user, or an OAuth U2M token. A service
   principal is never used to read user data. If no user credential is available the
   adapter raises; it does not fall back to a service principal, to a shared token, or to
   an empty result.
2. **No mirroring.** Unity Catalog grants are not copied into OpenFGA. A copy would go
   stale and could allow what Databricks denies; instead both checks must pass, and a user
   without a Unity Catalog grant is refused by Databricks even when riz allows.
3. **Provider configuration holds non-secret settings only.** The `provider_configs` table
   stores `{workspaceHost, warehouseId}` per application and provider. Credentials are
   never stored there, accepted by the API, or returned.
4. **Who may touch it.** Create, replace and delete need scope `providers:write` and the
   application on the caller's allow-list, and are audited (`providers.put`,
   `providers.delete`). Reading needs `providers:read` or `check`, plus the allow-list, so
   an application's bound workload can read its own configuration but not change it.

## Consequences and limits

- Only the `databricks` provider is accepted; a second provider adds its own validator.
- `workspaceHost` must be a bare `https` host name, so a stored value cannot point an
  adapter at a path, a port or a credential-bearing URL. It is not checked against an
  allow-list of workspaces. shortcut: add one if admins should not choose any host.
- Real Unity Catalog behaviour is **unverified** until run against an authorized workspace
  (see the adapters and `examples/databricks/`).
- Like other admin routes this uses token scopes, not the OpenFGA admin model (ADR 0004).
