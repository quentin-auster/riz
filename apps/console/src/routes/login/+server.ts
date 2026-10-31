import { redirect } from "@sveltejs/kit";
import { LOGIN_COOKIE, oidcConfig, oidcMetadata } from "$lib/server/context";
import { startLogin } from "$lib/server/oidc";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ cookies, url }) => {
  const { url: authorizeUrl, login } = startLogin(
    await oidcMetadata(),
    oidcConfig(),
  );
  cookies.set(LOGIN_COOKIE, JSON.stringify(login), {
    path: "/auth/callback",
    httpOnly: true,
    sameSite: "lax",
    secure: url.hostname !== "localhost",
    maxAge: 600,
  });
  redirect(303, authorizeUrl);
};
