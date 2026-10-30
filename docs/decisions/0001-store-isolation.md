# 0001 — Store isolation and cross-application role strategy

Status: accepted

## Context

riz serves many applications from one OpenFGA deployment. An application's
permissions must not be readable or influenceable by another application, yet
organization-wide roles (for example "acme admin") need to reach applications.

OpenFGA evaluates a check inside a single store. Relationships in one store
cannot reference objects in another, so inheritance never crosses stores.

## Decision

### Isolation

- **One OpenFGA store per application and environment** is the default.
- Stores are named `<app>-<env>` (lowercase, `[a-z0-9-]`), for example `crm-prod`.
- Store IDs and authorization model IDs are resolved **server-side** from the riz
  database. Callers never send them; the API contract has no such fields.
- Every OpenFGA call passes an explicit `authorization_model_id`
  (see the model pinning ADR, 0002).
- **Opt-in shared namespace:** several applications may share one store only when
  a platform administrator (a principal holding the `platform:admin` scope)
  enables it for a named group of applications. The enablement is audited, and
  object types in a shared store are prefixed by application (`crm_document`) so
  names cannot collide. It is not the default and not available to application
  owners.

### Cross-application roles: independently mapped application roles

Each application store holds its own tuples. An organization-wide role reaches
an application only through explicit, audited tuples written into that
application's store: the organization's role tuples (for example
`user:olga admin organization:acme`) and the parent link
(`organization:acme organization application:crm`). The model then derives
application roles from them (`admin from organization`). riz does not mirror,
sync, or automatically inherit roles between stores.

**Inheritance does not cross OpenFGA stores automatically.** Anything that looks
like cross-store inheritance is an explicit tuple in the target store.

### Alternatives considered

| Option | Why not chosen |
|--------|----------------|
| Shared organization store | One store holds every app's tuples: no isolation by construction, a single blast radius, and per-app model versions become entangled. |
| Synchronized contextual relationships | Needs a sync job and conflict handling; stale copies silently over- or under-grant. Adds infrastructure the milestone does not require. |
| Independently mapped roles (chosen) | Smallest blast radius and no sync machinery. Cost: org-wide changes must be applied per application, and an application can drift from the organization's intent. |

## Consequences

- Removing a person from the organization does not remove access in an
  application store until the application-level grants are revoked. Revocation
  tooling (RIZ-021) must make this visible.
- Platform administrators carry the extra responsibility of shared namespaces.

## Tests later milestones must add

To prove no cross-application leakage:

1. A tuple written to application A's store is invisible to a check against
   application B, including when both use identical object and user IDs.
2. A caller bound to application A that supplies application B's store or model
   ID in a request (query, body, or header) is rejected or the value is ignored.
3. A workload not permitted for an application receives 403 on check and
   batch-check for that application.
4. Registering two applications yields two distinct stores and bindings.
5. Relationship list/read endpoints for application A never return application B
   tuples.
6. Writing a new model to application A's store does not change application B's
   decisions.
7. If a shared namespace is enabled, application types remain prefix-isolated, and
   enabling it without `platform:admin` is denied and audited.
