import { error, redirect } from "@sveltejs/kit";
import {
  LOGIN_COOKIE,
  oidcConfig,
  oidcMetadata,
  SESSION_COOKIE,
  sessions,
} from "$lib/server/context";
import { finishLogin, type LoginState } from "$lib/server/oidc";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ cookies, url }) => {
  const raw = cookies.get(LOGIN_COOKIE);
  cookies.delete(LOGIN_COOKIE, { path: "/auth/callback" });
  let session: Awaited<ReturnType<typeof finishLogin>>;
  try {
    session = await finishLogin(
      await oidcMetadata(),
      oidcConfig(),
      url.searchParams,
      raw ? (JSON.parse(raw) as LoginState) : null,
    );
  } catch {
    // The reason can include token material; the user only learns that login failed.
    error(401, "Login failed.");
  }
  cookies.set(SESSION_COOKIE, sessions.create(session), {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: url.hostname !== "localhost",
    expires: new Date(session.expiresAt),
  });
  redirect(303, "/");
};
