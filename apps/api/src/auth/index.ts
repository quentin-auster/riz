import { fixtureAuthenticator, fixtureEndUserVerifier } from "./fixture.js";
import type { Authenticator, EndUserVerifier } from "./principal.js";

export type { Authenticator, EndUserVerifier, Principal } from "./principal.js";

/** Fails closed: with no recognized RIZ_AUTH_MODE the process cannot start. */
export function authenticatorFromEnv(env: NodeJS.ProcessEnv): Authenticator {
  if (env.RIZ_AUTH_MODE === "fixture") {
    return fixtureAuthenticator(env);
  }
  throw new Error("RIZ_AUTH_MODE must be set (supported: fixture)");
}

export function endUserVerifierFromEnv(
  env: NodeJS.ProcessEnv,
): EndUserVerifier {
  if (env.RIZ_AUTH_MODE === "fixture") {
    return fixtureEndUserVerifier(env);
  }
  throw new Error("RIZ_AUTH_MODE must be set (supported: fixture)");
}
