import type { Handle, HandleServerError } from "@sveltejs/kit";
import { redirect } from "@sveltejs/kit";
import { SESSION_COOKIE, sessions } from "$lib/server/context";
import { crossSiteMutation, loginRedirect } from "$lib/server/guard";

export const handle: Handle = async ({ event, resolve }) => {
  if (
    crossSiteMutation(
      event.request.method,
      event.request.headers.get("origin"),
      event.url.origin,
    )
  ) {
    return new Response("Cross-site request refused.", { status: 403 });
  }

  const session = sessions.get(event.cookies.get(SESSION_COOKIE));
  event.locals.session = session;
  const to = loginRedirect(event.url.pathname, session);
  if (to) redirect(303, to);

  const response = await resolve(event);
  response.headers.set("cache-control", "no-store");
  return response;
};

// Log the message only: errors can carry request details, never tokens we want in logs.
export const handleError: HandleServerError = ({ error, status }) => {
  console.error(
    JSON.stringify({ msg: "console error", status, error: String(error) }),
  );
  return { message: "Something went wrong." };
};
