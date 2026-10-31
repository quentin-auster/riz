# 0003 — Delegated end-user identity

Status: accepted

## Context

A workload calls riz on behalf of an end user, and the answer depends on who
that user is. A user identity in a header or body (`X-User: alice`) is a claim
by the caller, so a compromised or buggy workload could check as anyone
(AGENTS.md principle 8). The user must be bound to the request cryptographically.

## Decision

The workload sends **its own access token** (`Authorization: Bearer`) and the
**end user's access token** (`Riz-End-User-Token`) on every check. riz verifies
both against the configured issuers, and the effective user is the end-user
token's verified `sub`.

- No user identity is read from any other header, query parameter or body
  field. A body that names a user is rejected.
- The end-user token must be issued **to the calling workload**: its `azp`
  (authorized party) must equal the workload's identity. A token issued to
  another client is refused, so a leaked or misdirected user token cannot be
  replayed by a different workload.
- A workload without a verified user token cannot check; there is no
  service-principal mode.
- The effective user and the workload are separate facts: the workload is the
  `Principal` (and the audit actor); the user is resolved per request.

### Alternatives considered

- **OAuth token exchange (RFC 8693).** The most precise: the workload trades
  the user's token for one issued to itself with the user as `sub` and the
  workload as `act`. riz does not call the exchange; it accepts the result,
  which the `azp` rule above already admits. Deployments whose user token comes
  from a different client (for example a browser app forwarding to a backend)
  **must** use token exchange so the IdP issues the token to the workload.
- **Trust the workload to assert the user.** Rejected: it makes the workload a
  single point of impersonation.

## Consequences

- Revocation is not immediate: a user token is valid until `exp`.
  Short lifetimes are the operator's control.
- riz does not check `act`; `azp` is the binding. Add an `act` check if an IdP
  supports exchange but sets `azp` loosely.
- A workload can present its own token as the end-user token (its `azp` matches
  itself). The effective user is then the workload's own `sub`: it can check as
  its own identity, never as another user. riz cannot tell the two token kinds
  apart without an IdP-specific claim.
- `RIZ_AUTH_MODE=oidc` grants workloads `check` only, so administration needs
  the admin model (RIZ-019) before it works in that mode.
- Fixture end-user tokens (development only) have no `azp` and are exempt.
