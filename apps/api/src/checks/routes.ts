import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { EndUserVerifier, Principal } from "../auth/index.js";
import { HttpError, readJson, send } from "../http.js";
import { ApplicationNotFound } from "./resolver.js";
import { type CheckService, InvalidCheck } from "./service.js";

const APPLICATION = /^[a-z0-9][a-z0-9-]{0,62}$/;
const OBJECT = /^[a-z_]+:[^\s#]+$/;

function checkBody(body: unknown) {
  const b = body as Record<string, unknown> | null;
  if (
    typeof b !== "object" ||
    b === null ||
    Object.keys(b).some(
      (k) => k !== "application" && k !== "relation" && k !== "object",
    ) ||
    typeof b.application !== "string" ||
    !APPLICATION.test(b.application) ||
    typeof b.relation !== "string" ||
    !b.relation ||
    typeof b.object !== "string" ||
    !OBJECT.test(b.object)
  ) {
    throw new HttpError(
      400,
      "invalid_request",
      "Body must be {application, relation, object} with valid values.",
    );
  }
  return {
    application: b.application,
    relation: b.relation,
    object: b.object,
  };
}

/** Returns true if the request was handled. Business logic lives in the service. */
export function checkRoutes(deps: {
  service: CheckService;
  verifyEndUser: EndUserVerifier;
}) {
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    principal: Principal,
    url: URL,
  ): Promise<boolean> => {
    if (url.pathname !== "/v1/check" || req.method !== "POST") return false;

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
    const input = checkBody(await readJson(req));
    // Same answer as an unknown application, so existence is not leaked.
    if (
      !principal.applications.includes("*") &&
      !principal.applications.includes(input.application)
    ) {
      throw new HttpError(404, "not_found", "Application not found.");
    }

    try {
      const result = await deps.service.check(
        input.application,
        endUser,
        input,
      );
      send(res, 200, { ...result, requestId: `req_${randomUUID()}` });
    } catch (err) {
      if (err instanceof ApplicationNotFound) {
        throw new HttpError(404, "not_found", "Application not found.");
      }
      if (err instanceof InvalidCheck) {
        throw new HttpError(
          400,
          "invalid_request",
          "Unknown relation or object type for this application.",
        );
      }
      throw err;
    }
    return true;
  };
}
