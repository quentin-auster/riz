import {
  createRemoteJWKSet,
  decodeJwt,
  type JWTPayload,
  jwtVerify,
} from "jose";

export interface OidcIssuer {
  issuer: string;
  audience: string;
  jwksUri: string;
  /** Signature algorithms accepted. Defaults to RS256 and ES256. */
  algorithms?: readonly string[];
}

export interface VerifiedToken {
  issuer: string;
  subject: string;
  claims: JWTPayload;
}

/**
 * Resolves an access token to its verified claims, or null if it is not valid.
 * Throws if validity could not be determined (for example the JWKS is
 * unreachable), so callers fail closed instead of reporting a bad token.
 */
export type TokenVerifier = (token: string) => Promise<VerifiedToken | null>;

const DEFAULT_ALGORITHMS = ["RS256", "ES256"];

// Verification failures that mean "this token is not valid", as opposed to an outage.
const INVALID_TOKEN_CODES = new Set([
  "ERR_JWT_EXPIRED",
  "ERR_JWT_CLAIM_VALIDATION_FAILED",
  "ERR_JWT_INVALID",
  "ERR_JWS_INVALID",
  "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  "ERR_JOSE_ALG_NOT_ALLOWED",
  "ERR_JWKS_NO_MATCHING_KEY",
  "ERR_JWKS_MULTIPLE_MATCHING_KEYS",
]);

function isLocalhost(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1";
}

export function oidcTokenVerifier(
  issuers: readonly OidcIssuer[],
): TokenVerifier {
  if (issuers.length === 0) {
    throw new Error("at least one OIDC issuer is required");
  }
  const byIssuer = new Map<
    string,
    {
      audience: string;
      algorithms: string[];
      keys: ReturnType<typeof createRemoteJWKSet>;
    }
  >();
  for (const i of issuers) {
    const algorithms = [...(i.algorithms ?? DEFAULT_ALGORITHMS)];
    if (
      algorithms.length === 0 ||
      algorithms.some((a) => !/^(RS|PS|ES)\d+$|^EdDSA$/.test(a))
    ) {
      throw new Error(
        `issuer ${i.issuer}: only asymmetric algorithms are allowed`,
      );
    }
    const jwks = new URL(i.jwksUri);
    if (
      jwks.protocol !== "https:" &&
      !(jwks.protocol === "http:" && isLocalhost(jwks))
    ) {
      throw new Error(`issuer ${i.issuer}: jwksUri must be https`);
    }
    if (byIssuer.has(i.issuer)) throw new Error(`duplicate issuer ${i.issuer}`);
    byIssuer.set(i.issuer, {
      audience: i.audience,
      algorithms,
      // jose caches the key set, refetches on an unknown kid (rotation) at most
      // once per cooldown, and bounds each fetch by the timeout.
      keys: createRemoteJWKSet(jwks, {
        cooldownDuration: 30_000,
        cacheMaxAge: 600_000,
        timeoutDuration: 5_000,
      }),
    });
  }

  return async (token) => {
    let issuer: string | undefined;
    try {
      // Unverified, used only to pick the issuer's keys; jwtVerify then requires it to match.
      issuer = decodeJwt(token).iss;
    } catch {
      return null;
    }
    const config = issuer === undefined ? undefined : byIssuer.get(issuer);
    if (!issuer || !config) return null;
    try {
      const { payload } = await jwtVerify(token, config.keys, {
        issuer,
        audience: config.audience,
        algorithms: config.algorithms,
        requiredClaims: ["exp", "sub"],
      });
      return { issuer, subject: payload.sub as string, claims: payload };
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (typeof code === "string" && INVALID_TOKEN_CODES.has(code))
        return null;
      throw err;
    }
  };
}
