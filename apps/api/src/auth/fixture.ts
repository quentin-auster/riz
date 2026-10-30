import { readFileSync } from "node:fs";
import type { Authenticator, Principal } from "./principal.js";

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === "string");
}

/**
 * Development-only authentication from a static file mapping bearer token to
 * principal: `{"<token>": {"subject": "...", "scopes": [...], "applications": [...]}}`.
 * Refuses to load in production. Errors never include file contents, which hold credentials.
 */
export function fixtureAuthenticator(env: NodeJS.ProcessEnv): Authenticator {
  if (env.NODE_ENV === "production") {
    throw new Error("fixture authentication must not be used in production");
  }
  const file = env.RIZ_FIXTURE_AUTH_FILE;
  if (!file) {
    throw new Error(
      "RIZ_FIXTURE_AUTH_FILE is required for fixture authentication",
    );
  }

  const tokens = new Map<string, Principal>();
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null) throw new Error();
    for (const [token, p] of Object.entries(parsed)) {
      if (
        !token ||
        typeof p?.subject !== "string" ||
        !isStringArray(p.scopes) ||
        !isStringArray(p.applications)
      ) {
        throw new Error();
      }
      tokens.set(token, {
        subject: p.subject,
        scopes: p.scopes,
        applications: p.applications,
      });
    }
  } catch {
    // Deliberately no cause: parser errors can quote the file's credentials.
    throw new Error(`invalid fixture authentication file ${file}`);
  }

  return (authorization) => {
    const match = /^Bearer (\S+)$/.exec(authorization ?? "");
    return (match?.[1] && tokens.get(match[1])) || null;
  };
}
