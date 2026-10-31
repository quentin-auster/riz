import type { IncomingMessage, ServerResponse } from "node:http";
import type { Principal } from "../auth/index.js";
import { ApplicationNotFound } from "../checks/resolver.js";
import { HttpError, readJson, requestIdOf, send } from "../http.js";
import type { AuditFilter } from "./audit.js";
import {
  type AdminService,
  ApplicationExists,
  InvalidCursor,
  type PageParams,
} from "./service.js";

export const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const NAME = ID;
const ENVIRONMENT = /^[a-z0-9]{1,31}$/;

export function requireScope(principal: Principal, scope: string) {
  if (!principal.scopes.includes(scope)) {
    throw new HttpError(403, "forbidden", `Missing scope ${scope}.`);
  }
}

export function pageParams(url: URL): PageParams {
  const raw = url.searchParams.get("limit");
  const limit = raw === null ? 50 : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new HttpError(400, "invalid_request", "limit must be 1 to 100.");
  }
  return { cursor: url.searchParams.get("cursor") ?? undefined, limit };
}

function auditFilter(url: URL): AuditFilter {
  const application = url.searchParams.get("application") ?? undefined;
  const date = (name: string): Date | undefined => {
    const raw = url.searchParams.get(name);
    if (raw === null) return undefined;
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) {
      throw new HttpError(
        400,
        "invalid_request",
        `${name} must be a date-time.`,
      );
    }
    return d;
  };
  if (application !== undefined && !ID.test(application)) {
    throw new HttpError(400, "invalid_request", "Invalid application.");
  }
  const text = (name: string): string | undefined => {
    const raw = url.searchParams.get(name);
    if (raw === null) return undefined;
    if (raw === "" || raw.length > 128) {
      throw new HttpError(400, "invalid_request", `Invalid ${name}.`);
    }
    return raw;
  };
  return {
    application,
    actor: text("actor"),
    action: text("action"),
    from: date("from"),
    to: date("to"),
  };
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
      if (pathname === "/v1/me" && req.method === "GET") {
        // The caller's own authority, so a client can hide what the API would refuse.
        // It is a hint: every request is still authorized by the API.
        const { subject, scopes, applications } = principal;
        send(res, 200, { subject, scopes, applications });
      } else if (pathname === "/v1/applications" && req.method === "POST") {
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
        send(
          res,
          201,
          await service.register(principal.subject, input, requestIdOf(res)),
        );
      } else if (pathname === "/v1/audit" && req.method === "GET") {
        requireScope(principal, "audit:read");
        send(
          res,
          200,
          await service.audit(
            principal.applications,
            pageParams(url),
            auditFilter(url),
          ),
        );
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
