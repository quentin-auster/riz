# 0002 — Model versioning and pinning

Status: accepted

## Context

OpenFGA lets a caller omit `authorization_model_id`, in which case it evaluates
against the store's latest model. Writing a model therefore changes live
decisions for every caller that omitted the ID. riz treats model changes as
versioned migrations (AGENTS.md principle 11).

## Decision

- Every model write creates a new **immutable model ID**. Writing identical
  content twice yields two different IDs; neither is used implicitly.
- **Every runtime OpenFGA call passes an explicit `authorization_model_id`**,
  read from the riz database binding for that application and environment. The
  resolver refuses to call OpenFGA without one. "Latest" is never used.
- A new model takes effect only when the binding is changed to its ID, so
  writing a model to an application's store does not alter its decisions.

### File layout (`models/openfga/`)

| Path | Purpose |
|------|---------|
| `base.fga`, `tests.yaml` | Shared starter model and its assertions |
| `apps/<app>/model.fga`, `apps/<app>/tests.yaml` | One application's full model and assertions |

A model file is a complete DSL document; an application model starts as a copy
of `base.fga` and then diverges. A model always lives next to a `tests.yaml`
whose assertions must pass before it can be written.

### Tooling (`scripts/`)

```sh
pnpm --filter @riz/scripts model validate models/openfga/base.fga
pnpm --filter @riz/scripts model write models/openfga/base.fga --store-id <id> --api-url <url>
```

Run these from anywhere in the repository; relative paths resolve against where
you invoked `pnpm`. `write` parses the model, runs its assertions with the pinned `fga` CLI image,
writes it to the store and prints the new model ID. It rejects a model that does
not parse or whose assertions fail.

## Consequences

- Rolling a model forward or back is a binding change, not a model write.
- Model IDs must be stored; losing the binding means losing the pin.
