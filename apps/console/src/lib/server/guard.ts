import type { Session } from "./session.js";

const PUBLIC_PATHS = new Set(["/login", "/auth/callback"]);

/** Where an unauthenticated request goes, or null if it may proceed. */
export function loginRedirect(
  pathname: string,
  session: Session | null,
): string | null {
  return session || PUBLIC_PATHS.has(pathname) ? null : "/login";
}

/**
 * Mutations must come from this console's own origin. SvelteKit's built-in check only
 * covers form posts; this covers every non-safe method, including JSON.
 */
export function crossSiteMutation(
  method: string,
  origin: string | null,
  ownOrigin: string,
): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return false;
  return origin !== ownOrigin;
}
