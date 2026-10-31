const TYPE = "[a-z][a-z0-9_-]{0,49}";
const OBJECT_ID = "[A-Za-z0-9_@.+|-]{1,256}";
const OBJECT = new RegExp(`^${TYPE}:${OBJECT_ID}$`);
const SUBJECT = new RegExp(`^${TYPE}:(\\*|${OBJECT_ID}(#${TYPE})?)$`);
const RELATION = /^[a-z][a-z0-9_-]{0,49}$/;

export interface Tuple {
  subject: string;
  relation: string;
  object: string;
}

export type MutationResult =
  | { ok: true; auditEventId: string | null }
  | { ok: false; status: number; message: string };

/** Makes the API call as the logged-in user (see `mutate`). */
export type Mutator = (
  path: string,
  init: { method: string; body?: unknown },
) => Promise<MutationResult>;

export type ActionResult =
  | { status: 200; message: string; auditEventId: string | null }
  | { status: number; error: string };

/**
 * Shape check only, to save a round trip. The API validates against the application's
 * model, and its answer is what the user sees.
 */
export function parseTuple(form: FormData): Tuple | string {
  const field = (name: string) => String(form.get(name) ?? "").trim();
  const tuple = {
    subject: field("subject"),
    relation: field("relation"),
    object: field("object"),
  };
  if (!SUBJECT.test(tuple.subject)) {
    return "Subject must look like user:anne or team:eng#member.";
  }
  if (!RELATION.test(tuple.relation)) return "Relation is not valid.";
  if (!OBJECT.test(tuple.object)) return "Object must look like team:eng.";
  return tuple;
}

const outcome = (r: MutationResult, done: string): ActionResult =>
  r.ok
    ? { status: 200, message: done, auditEventId: r.auditEventId }
    : { status: r.status, error: r.message };

// A refusal by the API is reported as-is: hiding a button is not the enforcement.
export async function grant(
  mutator: Mutator,
  application: string,
  form: FormData,
): Promise<ActionResult> {
  const tuple = parseTuple(form);
  if (typeof tuple === "string") return { status: 400, error: tuple };
  return outcome(
    await mutator("/v1/relationships", {
      method: "POST",
      body: { application, relationships: [tuple] },
    }),
    "Relationship granted.",
  );
}

export async function revoke(
  mutator: Mutator,
  application: string,
  form: FormData,
): Promise<ActionResult> {
  // The page asks first, but a request that skips the page must not skip the question.
  if (form.get("confirm") !== "yes") {
    return { status: 400, error: "Revoking needs confirmation." };
  }
  const tuple = parseTuple(form);
  if (typeof tuple === "string") return { status: 400, error: tuple };
  const query = new URLSearchParams({ application, ...tuple });
  return outcome(
    await mutator(`/v1/relationships?${query}`, { method: "DELETE" }),
    "Relationship revoked.",
  );
}
