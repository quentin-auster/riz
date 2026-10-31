import type { IncomingMessage, ServerResponse } from "node:http";
import type { Principal } from "../auth/index.js";
import { ApplicationNotFound, NoActiveModel } from "../checks/resolver.js";
import { HttpError, readJson, requestIdOf, send } from "../http.js";
import {
  InvalidRelationship,
  type Relationship,
  RelationshipExists,
  RelationshipNotFound,
  type RelationshipService,
} from "./relationships.js";
import { ID, pageParams, requireScope } from "./routes.js";

const TYPE = "[a-z][a-z0-9_-]{0,49}";
const OBJECT_ID = "[A-Za-z0-9_@.+|-]{1,256}";
const OBJECT = new RegExp(`^${TYPE}:${OBJECT_ID}$`);
// A subject may also be a userset or wildcard.
const SUBJECT = new RegExp(`^${TYPE}:(\\*|${OBJECT_ID}(#${TYPE})?)$`);
const RELATION = /^[a-z][a-z0-9_-]{0,49}$/;

const invalid = (message: string) =>
  new HttpError(400, "invalid_request", message);

function toRelationship(v: unknown): Relationship {
  const r = v as Record<string, unknown> | null;
  if (
    typeof r !== "object" ||
    r === null ||
    Object.keys(r).some(
      (k) => !["subject", "relation", "object"].includes(k),
    ) ||
    typeof r.subject !== "string" ||
    !SUBJECT.test(r.subject) ||
    typeof r.relation !== "string" ||
    !RELATION.test(r.relation) ||
    typeof r.object !== "string" ||
    !OBJECT.test(r.object)
  ) {
    throw invalid("A relationship must be {subject, relation, object}.");
  }
  return { subject: r.subject, relation: r.relation, object: r.object };
}

function applicationOf(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) {
    throw invalid("application is required.");
  }
  return value;
}

/**
 * Decided before the application is looked up, so an application outside the caller's
 * allow-list is 403 whether or not it exists.
 */
function permit(principal: Principal, application: string) {
  if (
    !principal.applications.includes("*") &&
    !principal.applications.includes(application)
  ) {
    throw new HttpError(
      403,
      "forbidden",
      "Not permitted to administer this application.",
    );
  }
}

function translate(err: unknown): unknown {
  if (err instanceof ApplicationNotFound) {
    return new HttpError(404, "not_found", "Application not found.");
  }
  if (err instanceof NoActiveModel) {
    return new HttpError(409, "conflict", "Application has no active model.");
  }
  if (err instanceof InvalidRelationship) {
    return invalid(`Relationship rejected: ${err.message.slice(0, 200)}`);
  }
  if (err instanceof RelationshipExists) {
    return new HttpError(409, "conflict", "Relationship already exists.");
  }
  if (err instanceof RelationshipNotFound) {
    return new HttpError(404, "not_found", "Relationship not found.");
  }
  return err;
}

/** Returns true if the request was handled. Business logic lives in the service. */
export function relationshipRoutes(service: RelationshipService) {
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    principal: Principal,
    url: URL,
  ): Promise<boolean> => {
    if (url.pathname !== "/v1/relationships") return false;
    const q = url.searchParams;
    try {
      if (req.method === "GET") {
        requireScope(principal, "relationships:read");
        const application = applicationOf(q.get("application"));
        const object = q.get("object") ?? undefined;
        const relation = q.get("relation") ?? undefined;
        if (object !== undefined && !OBJECT.test(object)) {
          throw invalid("Invalid object filter.");
        }
        if (relation !== undefined && !RELATION.test(relation)) {
          throw invalid("Invalid relation filter.");
        }
        permit(principal, application);
        send(
          res,
          200,
          await service.list(
            application,
            { object, relation },
            pageParams(url),
          ),
        );
      } else if (req.method === "POST") {
        requireScope(principal, "relationships:write");
        const body = (await readJson(req)) as Record<string, unknown> | null;
        if (
          typeof body !== "object" ||
          body === null ||
          Object.keys(body).some(
            (k) => k !== "application" && k !== "relationships",
          ) ||
          !Array.isArray(body.relationships) ||
          body.relationships.length < 1 ||
          body.relationships.length > 100
        ) {
          throw invalid("Body must be {application, relationships[1..100]}.");
        }
        const application = applicationOf(body.application);
        const relationships = body.relationships.map(toRelationship);
        permit(principal, application);
        await service.write(
          principal.subject,
          application,
          relationships,
          requestIdOf(res),
        );
        res.statusCode = 204;
        res.end();
      } else if (req.method === "DELETE") {
        requireScope(principal, "relationships:write");
        const application = applicationOf(q.get("application"));
        const relationship = toRelationship({
          subject: q.get("subject"),
          relation: q.get("relation"),
          object: q.get("object"),
        });
        permit(principal, application);
        await service.remove(
          principal.subject,
          application,
          relationship,
          requestIdOf(res),
        );
        res.statusCode = 204;
        res.end();
      } else {
        return false;
      }
      return true;
    } catch (err) {
      throw translate(err);
    }
  };
}
