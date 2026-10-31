import type { IncomingMessage, ServerResponse } from "node:http";
import type { Principal } from "../auth/index.js";
import { ApplicationNotFound } from "../checks/resolver.js";
import { HttpError, readJson, requestIdOf, send } from "../http.js";
import {
  type Assertion,
  AssertionsFailed,
  InvalidModel,
  ModelAlreadyActive,
  ModelNotFound,
  type ModelService,
} from "./models.js";
import { applicationOf, permit, toRelationship } from "./relationshipRoutes.js";
import { InvalidRelationship } from "./relationships.js";
import { requireScope } from "./routes.js";

const MAX_MODEL_CHARS = 200_000;
const MAX_TUPLES = 100;
const MAX_ASSERTIONS = 200;
// OpenFGA model IDs are ULIDs.
const MODEL_ID = /^[0-9A-Z]{26}$/;

const invalid = (message: string) =>
  new HttpError(400, "invalid_request", message);

function toAssertion(v: unknown): Assertion {
  const a = v as Record<string, unknown> | null;
  if (typeof a !== "object" || a === null || typeof a.allowed !== "boolean") {
    throw invalid("An assertion must be {subject, relation, object, allowed}.");
  }
  const { allowed, ...rest } = a;
  return { ...toRelationship(rest), allowed };
}

function submitBody(body: unknown) {
  const b = body as Record<string, unknown> | null;
  if (
    typeof b !== "object" ||
    b === null ||
    Object.keys(b).some(
      (k) => !["application", "model", "tuples", "assertions"].includes(k),
    ) ||
    typeof b.model !== "string" ||
    b.model.length < 1 ||
    b.model.length > MAX_MODEL_CHARS ||
    (b.tuples !== undefined &&
      (!Array.isArray(b.tuples) || b.tuples.length > MAX_TUPLES)) ||
    !Array.isArray(b.assertions) ||
    b.assertions.length < 1 ||
    b.assertions.length > MAX_ASSERTIONS
  ) {
    throw invalid(
      "Body must be {application, model, tuples?[0..100], assertions[1..200]}.",
    );
  }
  const assertions = b.assertions.map(toAssertion);
  // A model that is only ever shown allowing things proves nothing about what it denies.
  if (
    !assertions.some((a) => a.allowed) ||
    !assertions.some((a) => !a.allowed)
  ) {
    throw invalid("Assertions must include at least one allow and one deny.");
  }
  return {
    application: applicationOf(b.application),
    model: b.model,
    tuples: (b.tuples ?? []).map(toRelationship),
    assertions,
  };
}

function translate(err: unknown): unknown {
  if (err instanceof ApplicationNotFound) {
    return new HttpError(404, "not_found", "Application not found.");
  }
  if (err instanceof InvalidModel || err instanceof InvalidRelationship) {
    return invalid(err.message.slice(0, 300));
  }
  if (err instanceof AssertionsFailed) {
    return new HttpError(422, "assertions_failed", err.message);
  }
  if (err instanceof ModelNotFound) {
    return new HttpError(404, "not_found", "Model not found.");
  }
  if (err instanceof ModelAlreadyActive) {
    return new HttpError(409, "conflict", "Model is already active.");
  }
  return err;
}

/** Returns true if the request was handled. Business logic lives in the service. */
export function modelRoutes(service: ModelService) {
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    principal: Principal,
    url: URL,
  ): Promise<boolean> => {
    const { pathname } = url;
    if (req.method !== "POST") return false;
    const isRollback = pathname === "/v1/models/rollback";
    if (pathname !== "/v1/models" && !isRollback) return false;

    try {
      requireScope(principal, "models:write");
      const body = await readJson(req);
      if (isRollback) {
        const b = body as Record<string, unknown> | null;
        if (
          typeof b !== "object" ||
          b === null ||
          Object.keys(b).some((k) => k !== "application" && k !== "modelId") ||
          typeof b.modelId !== "string" ||
          !MODEL_ID.test(b.modelId)
        ) {
          throw invalid("Body must be {application, modelId}.");
        }
        const application = applicationOf(b.application);
        permit(principal, application);
        send(
          res,
          200,
          await service.rollback(
            principal.subject,
            application,
            b.modelId,
            requestIdOf(res),
          ),
        );
      } else {
        const input = submitBody(body);
        permit(principal, input.application);
        send(
          res,
          201,
          await service.submit(
            principal.subject,
            input.application,
            input,
            requestIdOf(res),
          ),
        );
      }
      return true;
    } catch (err) {
      throw translate(err);
    }
  };
}
