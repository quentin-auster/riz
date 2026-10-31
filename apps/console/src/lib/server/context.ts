import { env } from "$env/dynamic/private";
import { discover, type OidcConfig, type OidcMetadata } from "./oidc.js";
import { createSessionStore } from "./session.js";

function required(name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export const sessions = createSessionStore();
export const SESSION_COOKIE = "riz_session";
export const LOGIN_COOKIE = "riz_login";

export const apiUrl = () => required("RIZ_API_URL").replace(/\/$/, "");

export const oidcConfig = (): OidcConfig => ({
  issuer: required("OIDC_ISSUER"),
  clientId: required("OIDC_CLIENT_ID"),
  redirectUri: required("OIDC_REDIRECT_URI"),
  ...(env.OIDC_CLIENT_SECRET ? { clientSecret: env.OIDC_CLIENT_SECRET } : {}),
  ...(env.OIDC_AUDIENCE ? { audience: env.OIDC_AUDIENCE } : {}),
});

let metadata: Promise<OidcMetadata> | undefined;
/** Discovered once; a failed discovery is retried on the next request. */
export function oidcMetadata(): Promise<OidcMetadata> {
  metadata ??= discover(oidcConfig().issuer).catch((err) => {
    metadata = undefined;
    throw err;
  });
  return metadata;
}
