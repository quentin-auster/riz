import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  /** Audience of the access token the riz API accepts, when it differs from the client. */
  audience?: string;
}

export interface OidcMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

/** Kept in a short-lived httpOnly cookie between the redirect and the callback. */
export interface LoginState {
  state: string;
  verifier: string;
  nonce: string;
}

const random = () => randomBytes(32).toString("base64url");

export async function discover(
  issuer: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OidcMetadata> {
  const res = await fetchImpl(
    `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
  );
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
  const meta = (await res.json()) as OidcMetadata;
  // A discovery document for a different issuer must not be trusted.
  if (meta.issuer !== issuer) throw new Error("OIDC issuer mismatch");
  return meta;
}

/** Authorization-code flow with PKCE (S256). */
export function startLogin(
  meta: OidcMetadata,
  config: OidcConfig,
): { url: string; login: LoginState } {
  const login = { state: random(), verifier: random(), nonce: random() };
  const url = new URL(meta.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: "openid",
    state: login.state,
    nonce: login.nonce,
    code_challenge: createHash("sha256")
      .update(login.verifier)
      .digest("base64url"),
    code_challenge_method: "S256",
    ...(config.audience ? { audience: config.audience } : {}),
  }).toString();
  return { url: url.toString(), login };
}

export async function finishLogin(
  meta: OidcMetadata,
  config: OidcConfig,
  query: URLSearchParams,
  saved: LoginState | null,
  deps: { fetch?: typeof fetch; now?: () => number } = {},
): Promise<{ subject: string; accessToken: string; expiresAt: number }> {
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const code = query.get("code");
  if (!saved || !code || query.get("state") !== saved.state) {
    throw new Error("invalid login response");
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    code_verifier: saved.verifier,
    ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
  });
  const res = await fetchImpl(meta.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  // The response body can carry tokens or secrets, so it is never put in the error.
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
  const tokens = (await res.json()) as {
    access_token?: unknown;
    id_token?: unknown;
  };
  if (
    typeof tokens.access_token !== "string" ||
    typeof tokens.id_token !== "string"
  ) {
    throw new Error("token response is missing tokens");
  }

  const { payload } = await jwtVerify(
    tokens.id_token,
    createRemoteJWKSet(new URL(meta.jwks_uri)),
    {
      issuer: meta.issuer,
      audience: config.clientId,
      algorithms: ["RS256", "ES256"],
      requiredClaims: ["exp", "sub"],
    },
  );
  if (payload.nonce !== saved.nonce) throw new Error("nonce mismatch");

  // The session never outlives the ID token, so an expired login is not kept alive.
  return {
    subject: payload.sub as string,
    accessToken: tokens.access_token,
    expiresAt: Math.max(now(), (payload.exp as number) * 1000),
  };
}
