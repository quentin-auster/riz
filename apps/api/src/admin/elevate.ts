import { createHash } from "node:crypto";
import type { Principal } from "../auth/index.js";
import type { AdminAuthorizer } from "./authorizer.js";

const SECURITY_ADMIN = [
  "applications:read",
  "applications:write",
  "audit:read",
  "bindings:write",
  "explorer:check",
  "models:read",
  "models:write",
  "providers:read",
  "providers:write",
  "relationships:read",
  "relationships:write",
];

/**
 * A workload's name in the riz-admin store. An issuer URL holds `:` and `/`, which cannot be
 * an OpenFGA user ID, so the store is keyed by the SHA-256 of the JSON pair (JSON, so no
 * separator inside either value can make two pairs collide).
 */
export const adminSubject = (issuer: string, workload: string) =>
  createHash("sha256")
    .update(JSON.stringify([issuer, workload]))
    .digest("hex");

/**
 * Adds the admin scopes a workload holds in the riz-admin store, on all applications.
 * Only organization roles are read: an application-level admin gets no scopes yet, since
 * scopes are global and could not keep it to its own application.
 * For admin routes only. The check path must never wait on the admin store.
 */
export function withAdminScopes(authorizer: AdminAuthorizer) {
  return async (principal: Principal): Promise<Principal> => {
    // Only a token minted for administration can hold admin roles: a user login for the same
    // client carries the same client ID but not the admin audience.
    if (!principal.admin || !principal.issuer || !principal.clientId) {
      return principal;
    }
    const subject = adminSubject(principal.issuer, principal.clientId);
    const [security, readApps, readAudit] = await Promise.all([
      authorizer.organization(subject, "security_admin"),
      authorizer.organization(subject, "can_read_applications"),
      authorizer.organization(subject, "can_read_audit"),
    ]);
    const granted = security
      ? SECURITY_ADMIN
      : [
          ...(readApps ? ["applications:read", "models:read"] : []),
          ...(readAudit ? ["audit:read"] : []),
        ];
    if (granted.length === 0) return principal;
    return {
      ...principal,
      scopes: [...principal.scopes, ...granted],
      applications: ["*"],
    };
  };
}
