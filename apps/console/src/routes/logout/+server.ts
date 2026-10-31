import { redirect } from "@sveltejs/kit";
import { SESSION_COOKIE, sessions } from "$lib/server/context";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ cookies }) => {
  sessions.destroy(cookies.get(SESSION_COOKIE));
  cookies.delete(SESSION_COOKIE, { path: "/" });
  redirect(303, "/login");
};
