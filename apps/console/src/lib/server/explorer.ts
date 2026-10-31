const APPLICATION = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PRINCIPAL = /^[A-Za-z0-9._@+-]{1,128}$/;
const OBJECT = /^[a-z_]+:[^\s#]+$/;

export interface ExplorerAnswer {
  status: string;
  requestId: string;
  modelId?: string;
  code?: string;
}

export type ExplorerResult =
  | { status: 200; answer: ExplorerAnswer }
  | { status: number; error: string };

/** Makes the API call as the logged-in user (see `mutate`). */
export type Poster = (
  path: string,
  init: { method: string; body?: unknown },
) => Promise<
  { ok: true; body: unknown } | { ok: false; status: number; message: string }
>;

/**
 * Asks the API whether `principal` holds `relation` on `object`. The shape check only saves
 * a round trip; the API authorizes the query and a refusal is shown as-is.
 */
export async function explore(
  post: Poster,
  form: FormData,
): Promise<ExplorerResult> {
  const field = (name: string) => String(form.get(name) ?? "").trim();
  const query = {
    application: field("application"),
    principal: field("principal"),
    relation: field("relation"),
    object: field("object"),
  };
  if (!APPLICATION.test(query.application)) {
    return { status: 400, error: "Application is not valid." };
  }
  if (!PRINCIPAL.test(query.principal)) {
    return { status: 400, error: "Principal must look like anne." };
  }
  if (query.relation === "")
    return { status: 400, error: "Relation is required." };
  if (!OBJECT.test(query.object)) {
    return { status: 400, error: "Object must look like document:d1." };
  }
  const r = await post("/v1/explorer/check", { method: "POST", body: query });
  return r.ok
    ? { status: 200, answer: r.body as ExplorerAnswer }
    : { status: r.status, error: r.message };
}
