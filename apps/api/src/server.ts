import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Authenticator, Principal } from "./auth/index.js";
import {
  HttpError,
  newRequestId,
  requestIdOf,
  send,
  sendError,
} from "./http.js";
import { type Log, stdoutLog } from "./logging.js";

type Routes = (
  req: IncomingMessage,
  res: ServerResponse,
  principal: Principal,
  url: URL,
) => Promise<boolean>;

export function createApp(opts: {
  authenticate: Authenticator;
  routes: Routes;
  /** Names of the dependencies that are down; empty means ready. */
  readiness: () => Promise<string[]>;
  log?: Log;
}): Server {
  const log = opts.log ?? stdoutLog;

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/health/live") {
      send(res, 200, { status: "ok" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/health/ready") {
      const down = await opts.readiness();
      if (down.length > 0) {
        log({ msg: "not ready", requestId: requestIdOf(res), down });
        throw new HttpError(503, "not_ready", "Not ready.");
      }
      send(res, 200, { status: "ok" });
      return;
    }
    // Everything else, including routes that do not exist yet, requires authentication.
    if (url.pathname.startsWith("/v1/")) {
      const principal = await opts.authenticate(req.headers.authorization);
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
    const requestId = newRequestId(
      typeof req.headers["x-request-id"] === "string"
        ? req.headers["x-request-id"]
        : undefined,
    );
    res.setHeader("x-request-id", requestId);
    const started = Date.now();
    // Path only: never the query string, headers or body.
    const path = (req.url ?? "/").split("?")[0];
    res.on("finish", () => {
      log({
        msg: "request",
        requestId,
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Date.now() - started,
      });
    });

    handle(req, res).catch((err) => {
      if (res.headersSent) return;
      if (err instanceof HttpError) return sendError(res, err);
      // Fail closed without leaking internals; log the error type only.
      log({ msg: "unhandled error", requestId, error: String(err?.name) });
      sendError(res, new HttpError(500, "internal", "Internal error."));
    });
  });
}
