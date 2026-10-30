import type { IncomingMessage, ServerResponse } from "node:http";
import type { Principal } from "../auth/index.js";
import { ApplicationNotFound } from "../checks/resolver.js";
import { HttpError, readJson, send } from "../http.js";
import {
  type AdminService,
  ApplicationExists,
  InvalidCursor,
  type PageParams,
} from "./service.js";

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const NAME = ID;
const ENVIRONMENT = /^[a-z0-9]{1,31}$/;

function requireScope(principal: Principal, scope: string) {
  if (!principal.scopes.includes(scope)) {
    throw new HttpError(403, "forbidden", `Missing scope ${scope}.`);
  }
}

function pageParams(url: URL): PageParams {
  const raw = url.searchParams.get("limit");
  const limit = raw === null ? 50 : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new HttpError(400, "invalid_request", "limit must be 1 to 100.");
  }
  return { cursor: url.searchParams.get("cursor") ?? undefined, limit };
}

function createBody(body: unknown): { name: string; environment: string } {
  const b = body as Record<string, unknown> | null;
  if (
    typeof b !== "object" ||
    b === null ||
    Object.keys(b).some((k) => k !== "name" && k !== "environment") ||
    typeof b.name !== "string" ||
    !NAME.test(b.name) ||
    typeof b.environment !== "string" ||
    !ENVIRONMENT.test(b.environment)
  ) {
    throw new HttpError(
      400,
      "invalid_request",
      "Body must be {name, environment} with valid values.",
    );
  }
  return { name: b.name, environment: b.environment };
}

function translate(err: unknown): unknown {
  if (err instanceof ApplicationNotFound) {
    return new HttpError(404, "not_found", "Application not found.");
  }
  if (err instanceof ApplicationExists) {
    return new HttpError(409, "conflict", "Application already exists.");
  }
  if (err instanceof InvalidCursor) {
    return new HttpError(400, "invalid_request", "Invalid cursor.");
  }
  return err;
}

/** Returns true if the request was handled. Business logic lives in the service. */
export function adminRoutes(service: AdminService) {
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    principal: Principal,
    url: URL,
  ): Promise<boolean> => {
    const { pathname } = url;
    const byId = /^\/v1\/applications\/([^/]+)$/.exec(pathname)?.[1];
    try {
      if (pathname === "/v1/applications" && req.method === "POST") {
        requireScope(principal, "applications:write");
        // Registration can reveal whether an ID is taken, so it is for platform administrators.
        if (!principal.applications.includes("*")) {
          throw new HttpError(
            403,
            "forbidden",
            "Registering applications requires an all-applications allow-list.",
          );
        }
        const input = createBody(await readJson(req));
        send(res, 201, await service.register(principal.subject, input));
      } else if (pathname === "/v1/applications" && req.method === "GET") {
        requireScope(principal, "applications:read");
        send(
          res,
          200,
          await service.list(principal.applications, pageParams(url)),
        );
      } else if (byId && req.method === "GET") {
        requireScope(principal, "applications:read");
        send(res, 200, await service.get(byId, principal.applications));
      } else if (pathname === "/v1/models" && req.method === "GET") {
        requireScope(principal, "models:read");
        const application = url.searchParams.get("application");
        if (!application || !ID.test(application)) {
          throw new HttpError(
            400,
            "invalid_request",
            "application is required.",
          );
        }
        send(
          res,
          200,
          await service.models(
            application,
            principal.applications,
            pageParams(url),
          ),
        );
      } else {
        return false;
      }
      return true;
    } catch (err) {
      throw translate(err);
    }
  };
}
