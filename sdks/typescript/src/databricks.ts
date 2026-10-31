/**
 * Run SQL on Databricks as the signed-in user (ADR 0007).
 *
 * Unity Catalog decides what the user may read. The user's own delegated token is the only
 * credential this module sends; there is no service-principal or shared-token fallback.
 */
import { RizError } from "./index.js";

/** Databricks Apps forwards the signed-in user's token in this header. */
export const FORWARDED_TOKEN_HEADER = "x-forwarded-access-token";

// The same shape the riz API accepts: a bare lower-case host, so no scheme, port, path or
// userinfo rides along. shortcut: any DNS name passes, so the caller must trust where the
// host comes from; restrict to Databricks suffixes or an allow-list if it is ever untrusted.
const HOST =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const DENIED_CODES = new Set(["PERMISSION_DENIED", "UNAUTHENTICATED"]);

/** No delegated user token was available. Nothing was sent to Databricks. */
export class MissingUserCredentialError extends RizError {}

/** Databricks did not return a result. `status` is 0 when it was not reached. */
export class DatabricksError extends RizError {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

/** Databricks refused the user: no Unity Catalog grant, or a bad or expired token. */
export class DatabricksDeniedError extends DatabricksError {}

export interface DatabricksOptions {
  workspaceHost: string;
  warehouseId: string;
  /** How long Databricks runs a statement before cancelling it, 5 to 50. Defaults to 30. */
  waitSeconds?: number;
  /** For tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
}

export interface QueryResult {
  statementId: string;
  columns: string[];
  /** Values arrive as strings (null for SQL NULL), as the JSON_ARRAY format returns them. */
  rows: (string | null)[][];
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const obj = (v: unknown): Json => (isObject(v) ? v : {});

/** The forwarded user token from a request's headers, matched case-insensitively. */
export function userTokenFromHeaders(
  headers: Headers | Record<string, string | string[] | undefined>,
): string {
  const value =
    headers instanceof Headers
      ? headers.get(FORWARDED_TOKEN_HEADER)
      : Object.entries(headers).find(
          ([name]) => name.toLowerCase() === FORWARDED_TOKEN_HEADER,
        )?.[1];
  // A repeated header is ambiguous, so it is not used: an array, or the ", "-joined string
  // that Headers.get returns (a token never contains a comma).
  if (typeof value === "string" && value !== "" && !value.includes(",")) {
    return value;
  }
  throw new MissingUserCredentialError(
    `no ${FORWARDED_TOKEN_HEADER} header; refusing to query without the user's credential`,
  );
}

function failure(
  status: number,
  code: string | undefined,
  message: string,
): DatabricksError {
  const denied =
    status === 401 ||
    status === 403 ||
    (code !== undefined && DENIED_CODES.has(code));
  return new (denied ? DatabricksDeniedError : DatabricksError)(
    status,
    code,
    message,
  );
}

function toResult(body: Json): QueryResult {
  const status = obj(body.status);
  if (status.state !== "SUCCEEDED") {
    const error = obj(status.error);
    throw failure(
      200,
      str(error.error_code),
      str(error.message) ?? `statement ended as ${String(status.state)}`,
    );
  }
  const manifest = obj(body.manifest);
  const result = obj(body.result);
  const columns = obj(manifest.schema).columns;
  const rows = result.data_array ?? [];
  const statementId = str(body.statement_id);
  if (
    !Array.isArray(columns) ||
    !Array.isArray(rows) ||
    statementId === undefined
  ) {
    throw new DatabricksError(
      200,
      "invalid_response",
      "Databricks returned an unusable response",
    );
  }
  // A partial result would look like a complete one, so it is an error.
  if (manifest.truncated || (result.next_chunk_index ?? null) !== null) {
    throw new DatabricksError(
      200,
      "result_too_large",
      "result does not fit one inline chunk",
    );
  }
  return {
    statementId,
    columns: columns.map((c) => String(obj(c).name)),
    rows: rows as (string | null)[][],
  };
}

/**
 * Statement Execution API client for one workspace and SQL warehouse.
 * shortcut: statements wait server-side up to `waitSeconds` (max 50) and are cancelled
 * after that, and only the first inline chunk is read (a larger result raises); upgrade to
 * polling and chunk fetching when a caller needs longer queries or bigger results.
 */
export class Databricks {
  readonly #origin: string;
  readonly #warehouseId: string;
  readonly #waitSeconds: number;
  readonly #fetch: typeof fetch;

  constructor(options: DatabricksOptions) {
    if (!HOST.test(options.workspaceHost)) {
      throw new TypeError(
        "workspaceHost must be a bare host name, such as dbc-1.cloud.databricks.com",
      );
    }
    const waitSeconds = options.waitSeconds ?? 30;
    if (!Number.isInteger(waitSeconds) || waitSeconds < 5 || waitSeconds > 50) {
      throw new RangeError("waitSeconds must be an integer from 5 to 50");
    }
    this.#origin = `https://${options.workspaceHost}`;
    this.#warehouseId = options.warehouseId;
    this.#waitSeconds = waitSeconds;
    this.#fetch = options.fetch ?? fetch;
  }

  /**
   * Runs `statement` as the user. Rejects with MissingUserCredentialError without a token,
   * and DatabricksDeniedError when Databricks refuses the user.
   */
  async query(
    statement: string,
    options: {
      userToken: string | undefined;
      parameters?: Record<string, string>;
    },
  ): Promise<QueryResult> {
    if (!options.userToken) {
      throw new MissingUserCredentialError(
        "no user token; refusing to query without the user's credential",
      );
    }
    const payload: Json = {
      warehouse_id: this.#warehouseId,
      statement,
      wait_timeout: `${this.#waitSeconds}s`,
      on_wait_timeout: "CANCEL",
      format: "JSON_ARRAY",
      disposition: "INLINE",
      ...(options.parameters && Object.keys(options.parameters).length > 0
        ? {
            parameters: Object.entries(options.parameters).map(
              ([name, value]) => ({ name, value }),
            ),
          }
        : {}),
    };
    let status: number;
    let text: string;
    try {
      const res = await this.#fetch(`${this.#origin}/api/2.0/sql/statements`, {
        method: "POST",
        // The user's token must not follow a redirect to another host.
        redirect: "manual",
        signal: AbortSignal.timeout((this.#waitSeconds + 10) * 1000),
        headers: {
          authorization: `Bearer ${options.userToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      status = res.status;
      text = await res.text();
    } catch (cause) {
      // No `cause`: fetch's error can quote a header value, i.e. the user's token.
      throw new DatabricksError(
        0,
        undefined,
        `could not reach Databricks (${cause instanceof Error ? cause.name : "error"})`,
      );
    }
    let body: Json;
    try {
      body = obj(JSON.parse(text));
    } catch {
      body = {};
    }
    if (status !== 200) {
      throw failure(
        status,
        str(body.error_code),
        str(body.message) ?? `Databricks returned HTTP ${status}`,
      );
    }
    return toResult(body);
  }
}
