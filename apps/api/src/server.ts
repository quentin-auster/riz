import { randomUUID } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { Authenticator } from "./auth/index.js";

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function createApp(opts: { authenticate: Authenticator }): Server {
  return createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health/live") {
      send(res, 200, { status: "ok" });
      return;
    }
    // Everything else, including routes that do not exist yet, requires authentication.
    if (req.url?.startsWith("/v1/")) {
      const principal = opts.authenticate(req.headers.authorization);
      if (!principal) {
        send(res, 401, {
          code: "unauthenticated",
          message: "Missing or invalid bearer token.",
          requestId: `req_${randomUUID()}`,
        });
        return;
      }
    }
    send(res, 404, { code: "not_found" });
  });
}
