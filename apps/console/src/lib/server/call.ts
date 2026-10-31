import { error, redirect } from "@sveltejs/kit";
import { ApiError, apiJson, apiMutation } from "./api";
import { apiUrl } from "./context";
import type { Session } from "./session";

/**
 * Calls the API as the logged-in user. A rejected token sends the user back to login;
 * any other API refusal (403, 404, 409 ...) is shown with its own status.
 */
export async function callApi<T>(
  locals: { session: Session | null },
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  if (!locals.session) redirect(303, "/login");
  try {
    return await apiJson<T>(apiUrl(), locals.session, path, init);
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 401) redirect(303, "/login");
      error(err.status, err.message);
    }
    throw err;
  }
}

/**
 * Makes a change as the logged-in user. A refusal is returned, not thrown, so the form
 * can show it next to the input; the API decides, the console only reports.
 */
export async function mutate(
  locals: { session: Session | null },
  path: string,
  init: { method: string; body?: unknown },
): Promise<
  | { ok: true; auditEventId: string | null }
  | { ok: false; status: number; message: string }
> {
  if (!locals.session) redirect(303, "/login");
  try {
    return {
      ok: true,
      ...(await apiMutation(apiUrl(), locals.session, path, init)),
    };
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 401) redirect(303, "/login");
      return { ok: false, status: err.status, message: err.message };
    }
    throw err;
  }
}
