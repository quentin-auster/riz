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
 * A workload's name in the riz-admin store. `<issuer>|<workload>` holds `:` and `/`, which
 * cannot be an OpenFGA user ID, so the store is keyed by its SHA-256 instead.
 */
export const adminSubject = (workloadSubject: string) =>
  createHash("sha256").update(workloadSubject).digest("hex");

/**
 * Adds the admin scopes a workload holds in the riz-admin store, on all applications.
 * Only organization roles are read: an application-level admin gets no scopes yet, since
 * scopes are global and could not keep it to its own application.
 * For admin routes only. The check path must never wait on the admin store.
 */
export function withAdminScopes(authorizer: AdminAuthorizer) {
  return async (principal: Principal): Promise<Principal> => {
    const subject = adminSubject(principal.subject);
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
