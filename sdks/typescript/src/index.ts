export interface RizOptions {
  baseUrl: string;
  /** Bearer token identifying this workload to riz. */
  credentials: string;
  application: string;
  /** Total time allowed per request. Defaults to 5000. */
  timeoutMs?: number;
}

export interface Check {
  action: string;
  resource: string;
}

/** `allowed` is true only for `allow`; an undecidable check raises instead. */
export interface Decision {
  allowed: boolean;
  status: "allow" | "deny";
  requestId: string;
  modelId?: string;
}

export interface ItemDecision {
  allowed: boolean;
  status: "allow" | "deny" | "indeterminate";
}

export interface BatchDecision {
  requestId: string;
  modelId?: string;
  /** One per input check, in input order. */
  results: ItemDecision[];
}

export class RizError extends Error {
  readonly requestId: string | undefined;
  constructor(message: string, requestId?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.requestId = requestId;
  }
}

/** riz answered with something other than a decision. */
export class RizApiError extends RizError {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    requestId?: string,
  ) {
    super(message, requestId);
  }
}

/** 401 or 403: bad workload or end-user credentials, or a missing scope. */
export class RizAuthError extends RizApiError {}

/** 400: riz rejected the request. */
export class RizValidationError extends RizApiError {}

/** riz could not decide (for example its authorization backend timed out). */
export class RizIndeterminateError extends RizError {
  constructor(
    readonly code: string | undefined,
    requestId: string,
  ) {
    super(
      `riz could not decide${code ? ` (${code})` : ""}; treat as denied`,
      requestId,
    );
  }
}

/** riz was not reached or did not answer. */
export class RizTransportError extends RizError {}

export class RizTimeoutError extends RizTransportError {}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function httpError(status: number, parsed: unknown): RizApiError {
  const body = isObject(parsed) ? parsed : {};
  const Err =
    status === 400
      ? RizValidationError
      : status === 401 || status === 403
        ? RizAuthError
        : RizApiError;
  return new Err(
    status,
    str(body.code),
    str(body.message) ?? `riz returned HTTP ${status}`,
    str(body.requestId),
  );
}

const invalidResponse = () =>
  new RizApiError(200, "invalid_response", "riz returned an unusable response");

// Anything that is not `allow` is not an allow; `indeterminate` is kept apart.
function itemDecision(status: string | undefined): ItemDecision {
  if (status === "allow") return { allowed: true, status };
  if (status === undefined || status === "indeterminate") {
    return { allowed: false, status: "indeterminate" };
  }
  return { allowed: false, status: "deny" };
}

export class Riz {
  readonly #baseUrl: string;
  readonly #credentials: string;
  readonly #application: string;
  readonly #timeoutMs: number;

  constructor(options: RizOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#credentials = options.credentials;
    this.#application = options.application;
    this.#timeoutMs = options.timeoutMs ?? 5000;
  }

  /**
   * Whether `endUserToken`'s user holds `action` on `resource`. Raises
   * RizIndeterminateError when riz cannot decide; never resolves to allow then.
   */
  async check(input: Check & { endUserToken: string }): Promise<Decision> {
    const body = await this.#post("/v1/check", input.endUserToken, {
      application: this.#application,
      relation: input.action,
      object: input.resource,
    });
    const status = str(body.status);
    const requestId = str(body.requestId);
    if (status === undefined || requestId === undefined) {
      throw invalidResponse();
    }
    if (status === "indeterminate") {
      throw new RizIndeterminateError(str(body.code), requestId);
    }
    const allowed = status === "allow";
    const modelId = str(body.modelId);
    return {
      allowed,
      status: allowed ? "allow" : "deny",
      requestId,
      ...(modelId === undefined ? {} : { modelId }),
    };
  }

  /** At most 100 checks (riz may allow fewer). One item being indeterminate does not affect the rest. */
  async batchCheck(
    checks: readonly Check[],
    options: { endUserToken: string },
  ): Promise<BatchDecision> {
    const body = await this.#post("/v1/batch-check", options.endUserToken, {
      application: this.#application,
      checks: checks.map((c, i) => ({
        correlationId: String(i),
        relation: c.action,
        object: c.resource,
      })),
    });
    const requestId = str(body.requestId);
    if (requestId === undefined || !Array.isArray(body.results)) {
      throw invalidResponse();
    }
    const byId = new Map<string, string | undefined>();
    for (const r of body.results) {
      if (isObject(r) && typeof r.correlationId === "string") {
        // A repeated ID is ambiguous, so neither answer is used.
        byId.set(
          r.correlationId,
          byId.has(r.correlationId) ? undefined : str(r.status),
        );
      }
    }
    const modelId = str(body.modelId);
    return {
      requestId,
      ...(modelId === undefined ? {} : { modelId }),
      results: checks.map((_, i) => itemDecision(byId.get(String(i)))),
    };
  }

  async #post(
    path: string,
    endUserToken: string,
    payload: Json,
  ): Promise<Json> {
    let status: number;
    let text: string;
    try {
      const res = await fetch(this.#baseUrl + path, {
        method: "POST",
        // The end-user token must not follow a redirect to another host.
        redirect: "manual",
        signal: AbortSignal.timeout(this.#timeoutMs),
        headers: {
          authorization: `Bearer ${this.#credentials}`,
          "riz-end-user-token": endUserToken,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      status = res.status;
      text = await res.text();
    } catch (cause) {
      if (cause instanceof Error && cause.name === "TimeoutError") {
        throw new RizTimeoutError(
          `riz did not answer within ${this.#timeoutMs} ms`,
          undefined,
          { cause },
        );
      }
      // No `cause`: fetch's error can quote a header value, i.e. the end-user token.
      throw new RizTransportError(
        `could not reach riz (${cause instanceof Error ? cause.name : "error"})`,
      );
    }
    const parsed = parseJson(text);
    if (status !== 200) throw httpError(status, parsed);
    if (!isObject(parsed)) throw invalidResponse();
    return parsed;
  }
}
