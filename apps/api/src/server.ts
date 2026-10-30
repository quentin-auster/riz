import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Authenticator, Principal } from "./auth/index.js";
import { HttpError, send, sendError } from "./http.js";

type Routes = (
  req: IncomingMessage,
  res: ServerResponse,
  principal: Principal,
  url: URL,
) => Promise<boolean>;

export function createApp(opts: {
  authenticate: Authenticator;
  routes: Routes;
}): Server {
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/health/live") {
      send(res, 200, { status: "ok" });
      return;
    }
    // Everything else, including routes that do not exist yet, requires authentication.
    if (url.pathname.startsWith("/v1/")) {
      const principal = opts.authenticate(req.headers.authorization);
      if (!principal) {
        throw new HttpError(
          401,
          "unauthenticated",
          "Missing or invalid bearer token.",
        );
      }
      if (await opts.routes(req, res, principal, url)) return;
    }
    throw new HttpError(404, "not_found", "Not found.");
  }

  return createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) return;
      if (err instanceof HttpError) return sendError(res, err);
      // Fail closed without leaking internals; log the error type only.
      console.error(
        JSON.stringify({ msg: "unhandled error", error: String(err?.name) }),
      );
      sendError(res, new HttpError(500, "internal", "Internal error."));
    });
  });
}
