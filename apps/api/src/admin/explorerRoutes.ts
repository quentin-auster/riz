import type { IncomingMessage, ServerResponse } from "node:http";
import type pg from "pg";
import type { Principal } from "../auth/index.js";
import { ApplicationNotFound } from "../checks/resolver.js";
import { type CheckService, InvalidCheck } from "../checks/service.js";
import { HttpError, readJson, requestIdOf, send } from "../http.js";
import { recordAudit } from "./audit.js";
import { applicationOf, permit } from "./relationshipRoutes.js";
import { requireScope } from "./routes.js";

// Same shapes the check endpoint accepts: the principal is spliced into `user:<id>`.
const PRINCIPAL = /^[A-Za-z0-9._@+-]{1,128}$/;
const OBJECT = /^[a-z_]+:[^\s#]+$/;

const invalid = (message: string) =>
  new HttpError(400, "invalid_request", message);

/**
 * "Can principal P do R on O in application X?" for administrators. Unlike /v1/check, the
 * caller names the principal, so it has its own scope and every query is audited.
 * Returns true if the request was handled.
 */
export function explorerRoutes(deps: { checks: CheckService; pool: pg.Pool }) {
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    principal: Principal,
    url: URL,
  ): Promise<boolean> => {
    if (url.pathname !== "/v1/explorer/check" || req.method !== "POST") {
      return false;
    }
    requireScope(principal, "explorer:check");
    const body = (await readJson(req)) as Record<string, unknown> | null;
    if (
      typeof body !== "object" ||
      body === null ||
      Object.keys(body).some(
        (k) => !["application", "principal", "relation", "object"].includes(k),
      ) ||
      typeof body.principal !== "string" ||
      !PRINCIPAL.test(body.principal) ||
      typeof body.relation !== "string" ||
      body.relation === "" ||
      typeof body.object !== "string" ||
      !OBJECT.test(body.object)
    ) {
      throw invalid("Body must be {application, principal, relation, object}.");
    }
    const application = applicationOf(body.application);
    permit(principal, application);

    try {
      const result = await deps.checks.check(application, body.principal, {
        relation: body.relation,
        object: body.object,
      });
      // The answer is withheld if it cannot be recorded.
      await recordAudit(deps.pool, {
        actor: principal.subject,
        action: "explorer.check",
        applicationId: application,
        requestId: requestIdOf(res),
        detail: {
          principal: body.principal,
          relation: body.relation,
          object: body.object,
          decision: result.status,
        },
      });
      send(res, 200, { ...result, requestId: requestIdOf(res) });
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
