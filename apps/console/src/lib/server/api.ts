import type { Session } from "./session.js";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Calls the riz API as the logged-in user. The console never talks to OpenFGA or
 * Postgres; every decision, including "may this user see this", is the API's.
 */
export async function apiJson<T>(
  apiUrl: string,
  session: Session,
  path: string,
  init: { method?: string; body?: unknown } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const res = await fetchImpl(`${apiUrl}${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${session.accessToken}`,
      ...(init.body === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => null)) as {
    code?: string;
    message?: string;
  } | null;
  if (!res.ok) {
    throw new ApiError(
      res.status,
      json?.code ?? "error",
      json?.message ?? `API returned ${res.status}`,
    );
  }
  return json as T;
}

/** A change made through the API, with the audit event the API recorded for it. */
export async function apiMutation(
  apiUrl: string,
  session: Session,
  path: string,
  init: { method: string; body?: unknown },
  fetchImpl: typeof fetch = fetch,
): Promise<{ auditEventId: string | null }> {
  let auditEventId: string | null = null;
  await apiJson(apiUrl, session, path, init, async (url, opts) => {
    const res = await fetchImpl(url, opts);
    auditEventId = res.headers.get("riz-audit-event-id");
    return res;
  });
  return { auditEventId };
}
