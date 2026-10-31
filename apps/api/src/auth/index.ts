import { fixtureAuthenticator, fixtureEndUserVerifier } from "./fixture.js";
import { type OidcIssuer, oidcTokenVerifier } from "./oidc.js";
import type { Authenticator, EndUserVerifier } from "./principal.js";
import {
  type BindingLookup,
  oidcEndUserVerifier,
  workloadAuthenticator,
} from "./workloads.js";

export type { Authenticator, EndUserVerifier, Principal } from "./principal.js";

/** Fails closed: with no recognized RIZ_AUTH_MODE the process cannot start. */
export function authenticatorFromEnv(env: NodeJS.ProcessEnv): Authenticator {
  if (env.RIZ_AUTH_MODE === "fixture") {
    return fixtureAuthenticator(env);
  }
  throw new Error("RIZ_AUTH_MODE must be set (supported: fixture, oidc)");
}

export function endUserVerifierFromEnv(
  env: NodeJS.ProcessEnv,
): EndUserVerifier {
  if (env.RIZ_AUTH_MODE === "fixture") {
    return fixtureEndUserVerifier(env);
  }
  throw new Error("RIZ_AUTH_MODE must be set (supported: fixture, oidc)");
}

function issuersFromEnv(env: NodeJS.ProcessEnv): OidcIssuer[] {
  try {
    const parsed: unknown = JSON.parse(env.RIZ_OIDC_ISSUERS ?? "");
    if (!Array.isArray(parsed)) throw new Error();
    return parsed.map((i: Record<string, unknown>) => {
      if (
        typeof i.issuer !== "string" ||
        typeof i.audience !== "string" ||
        typeof i.jwksUri !== "string"
      ) {
        throw new Error();
      }
      return { issuer: i.issuer, audience: i.audience, jwksUri: i.jwksUri };
    });
  } catch {
    throw new Error(
      'RIZ_OIDC_ISSUERS must be a JSON array of {"issuer","audience","jwksUri"}',
    );
  }
}

/** Workload and end-user authentication from OIDC tokens; `lookup` supplies the workload's bindings. */
export function oidcAuthFromEnv(
  env: NodeJS.ProcessEnv,
  lookup: BindingLookup,
): { authenticate: Authenticator; verifyEndUser: EndUserVerifier } {
  const verify = oidcTokenVerifier(issuersFromEnv(env));
  return {
    authenticate: workloadAuthenticator(verify, lookup),
    verifyEndUser: oidcEndUserVerifier(verify),
  };
}
