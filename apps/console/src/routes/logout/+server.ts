import { redirect } from "@sveltejs/kit";
import { SESSION_COOKIE, sessions } from "$lib/server/context";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ cookies }) => {
  sessions.destroy(cookies.get(SESSION_COOKIE));
  cookies.delete(SESSION_COOKIE, { path: "/" });
  // Not /login: that would silently sign the user back in while the IdP session lives.
  redirect(303, "/signed-out");
};
