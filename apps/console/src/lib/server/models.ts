import type { MutationResult, Mutator } from "./relationships.js";

// OpenFGA model IDs are ULIDs.
export const MODEL_ID = /^[0-9A-Z]{26}$/;

export type RollbackResult =
  | { status: 200; message: string; auditEventId: string | null }
  | { status: number; error: string };

const outcome = (r: MutationResult): RollbackResult =>
  r.ok
    ? {
        status: 200,
        message: "Rolled back.",
        auditEventId: r.auditEventId,
      }
    : { status: r.status, error: r.message };

/**
 * Re-binds an earlier model. The page asks first, but a request that skips the page must
 * not skip the question; whether the caller may roll back is the API's call.
 */
export async function rollback(
  mutator: Mutator,
  application: string,
  form: FormData,
): Promise<RollbackResult> {
  if (form.get("confirm") !== "yes") {
    return { status: 400, error: "Rolling back needs confirmation." };
  }
  const modelId = String(form.get("modelId") ?? "");
  if (!MODEL_ID.test(modelId)) {
    return { status: 400, error: "Model ID is not valid." };
  }
  return outcome(
    await mutator("/v1/models/rollback", {
      method: "POST",
      body: { application, modelId },
    }),
  );
}
