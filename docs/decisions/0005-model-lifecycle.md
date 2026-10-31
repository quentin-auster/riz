# 0005 — Versioned model lifecycle

## Decision

An application's authorization model changes only through `POST /v1/models`, and only
if the caller's own assertions hold:

1. The submitted DSL and optional tuples are loaded into a **scratch store**
   (`riz-validate-<uuid>`), and every assertion is checked there at higher consistency.
   The application's store and binding are not touched. Assertions must include at least
   one allow and one deny, so a model cannot be approved on "it permits things" alone.
2. Only if every assertion holds is a **new immutable model** written to the application's
   store and bound (ADR 0002: a request never resolves "latest").
3. Binding runs in one transaction under a lock on the application row: deactivate the
   old binding, activate the new one, write the audit event (`models.bind`, with
   `before`/`after` model IDs). If the audit write fails, the binding does not change.

`POST /v1/models/rollback` re-binds a model the application was bound to before
(`models.rollback`). Earlier `model_bindings` rows are kept, so history is the table
itself. A model riz has never bound to the application cannot be restored.

Scope: `models:write`, plus the application allow-list, decided before the application is
looked up (403, not 404). Other applications are never touched.

## Consequences and limits

- Tuples already in the application's store are not re-validated against the new model;
  OpenFGA ignores tuples that no longer fit it, so a model that drops a relation silently
  stops honouring those tuples. The caller's assertions are what guard this.
- A failed scratch-store delete leaves an inert `riz-validate-*` store. shortcut: add a
  janitor if they accumulate.
- A model written to the application's store whose binding then fails stays unbound and
  inert.
- Like other admin routes this uses token scopes, not the OpenFGA admin model (ADR 0004).
