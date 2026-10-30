import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { EndUserVerifier, Principal } from "../auth/index.js";
import { HttpError, readJson, send } from "../http.js";
import { ApplicationNotFound } from "./resolver.js";
import { type BatchItem, type CheckService, InvalidCheck } from "./service.js";

const APPLICATION = /^[a-z0-9][a-z0-9-]{0,62}$/;
const OBJECT = /^[a-z_]+:[^\s#]+$/;

function invalid(message: string) {
  return new HttpError(400, "invalid_request", message);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hasOnly(b: Record<string, unknown>, keys: string[]) {
  return Object.keys(b).every((k) => keys.includes(k));
}

function isCheck(
  b: Record<string, unknown>,
): b is Record<string, unknown> & { relation: string; object: string } {
  return (
    typeof b.relation === "string" &&
    b.relation !== "" &&
    typeof b.object === "string" &&
    OBJECT.test(b.object)
  );
}

function applicationOf(b: Record<string, unknown>): string {
  if (typeof b.application !== "string" || !APPLICATION.test(b.application)) {
    throw invalid("application is required and must be a valid ID.");
  }
  return b.application;
}

function checkBody(body: unknown) {
  if (
    !isObject(body) ||
    !hasOnly(body, ["application", "relation", "object"]) ||
    !isCheck(body)
  ) {
    throw invalid(
      "Body must be {application, relation, object} with valid values.",
    );
  }
  return {
    application: applicationOf(body),
    relation: body.relation,
    object: body.object,
  };
}

function batchBody(body: unknown, maxBatchSize: number) {
  if (!isObject(body) || !hasOnly(body, ["application", "checks"])) {
    throw invalid("Body must be {application, checks}.");
  }
  const application = applicationOf(body);
  const { checks } = body;
  if (!Array.isArray(checks) || checks.length === 0) {
    throw invalid("checks must be a non-empty array.");
  }
  if (checks.length > maxBatchSize) {
    throw new HttpError(
      400,
      "batch_too_large",
      `A batch holds at most ${maxBatchSize} checks.`,
    );
  }
  const seen = new Set<string>();
  const items: BatchItem[] = checks.map((c: unknown) => {
    if (
      !isObject(c) ||
      !hasOnly(c, ["correlationId", "relation", "object"]) ||
      typeof c.correlationId !== "string" ||
      c.correlationId.length < 1 ||
      c.correlationId.length > 64 ||
      !isCheck(c)
    ) {
      throw invalid(
        "Each check must be {correlationId, relation, object} with valid values.",
      );
    }
    if (seen.has(c.correlationId)) {
      throw new HttpError(
        400,
        "duplicate_correlation_id",
        "correlationId must be unique within the batch.",
      );
    }
    seen.add(c.correlationId);
    return {
      correlationId: c.correlationId,
      relation: c.relation,
      object: c.object,
    };
  });
  return { application, items };
}

/** Returns true if the request was handled. Business logic lives in the service. */
export function checkRoutes(deps: {
  service: CheckService;
  verifyEndUser: EndUserVerifier;
  maxBatchSize: number;
}) {
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    principal: Principal,
    url: URL,
  ): Promise<boolean> => {
    const isBatch = url.pathname === "/v1/batch-check";
    if (!(isBatch || url.pathname === "/v1/check") || req.method !== "POST") {
      return false;
    }

    if (!principal.scopes.includes("check")) {
      throw new HttpError(403, "forbidden", "Missing scope check.");
    }
    const header = req.headers["riz-end-user-token"];
    const endUser = deps.verifyEndUser(
      typeof header === "string" ? header : undefined,
    );
    if (!endUser) {
      throw new HttpError(
        401,
        "invalid_end_user_token",
        "Missing or invalid end-user token.",
      );
    }
    const body = await readJson(req);
    const permit = (application: string) => {
      // Same answer as an unknown application, so existence is not leaked.
      if (
        !principal.applications.includes("*") &&
        !principal.applications.includes(application)
      ) {
        throw new HttpError(404, "not_found", "Application not found.");
      }
    };

    try {
      let result: object;
      if (isBatch) {
        const { application, items } = batchBody(body, deps.maxBatchSize);
        permit(application);
        result = await deps.service.batch(application, endUser, items);
      } else {
        const input = checkBody(body);
        permit(input.application);
        result = await deps.service.check(input.application, endUser, input);
      }
      send(res, 200, { ...result, requestId: `req_${randomUUID()}` });
    } catch (err) {
      if (err instanceof ApplicationNotFound) {
        throw new HttpError(404, "not_found", "Application not found.");
      }
      if (err instanceof InvalidCheck) {
        throw invalid("Unknown relation or object type for this application.");
      }
      throw err;
    }
    return true;
  };
}
