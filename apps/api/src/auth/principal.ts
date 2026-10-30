/** The verified caller of a request. Handlers receive this, never raw credentials. */
export interface Principal {
  subject: string;
  scopes: readonly string[];
  /** Application IDs this caller may act on. */
  applications: readonly string[];
}

/** Resolves an end-user token to the verified end-user subject, or null if it is not valid. */
export type EndUserVerifier = (token: string | undefined) => string | null;

/** Resolves an `Authorization` header to a Principal, or null if it is not valid. */
export type Authenticator = (
  authorization: string | undefined,
) => Principal | null;
