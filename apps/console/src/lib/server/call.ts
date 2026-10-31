import { error, redirect } from "@sveltejs/kit";
import { ApiError, apiJson } from "./api";
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
