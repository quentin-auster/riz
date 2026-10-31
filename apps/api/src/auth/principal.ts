/** The verified caller of a request. Handlers receive this, never raw credentials. */
export interface Principal {
  subject: string;
  scopes: readonly string[];
  /** Application IDs this caller may act on. */
  applications: readonly string[];
  /** The workload's verified client identity; set when it authenticated with a token. */
  clientId?: string;
}

/**
 * Resolves an end-user token, presented by `caller`, to the verified end-user
 * subject, or null if it is not valid. Throws if that could not be determined.
 */
export type EndUserVerifier = (
  token: string | undefined,
  caller: Principal,
) => string | null | Promise<string | null>;

/**
 * Resolves an `Authorization` header to a Principal, or null if it is not valid.
 * Throws if that could not be determined; the server then fails the request.
 */
export type Authenticator = (
  authorization: string | undefined,
) => Principal | null | Promise<Principal | null>;
