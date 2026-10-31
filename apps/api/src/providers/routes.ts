import type { IncomingMessage, ServerResponse } from "node:http";
import { applicationOf, permit } from "../admin/relationshipRoutes.js";
import { requireScope } from "../admin/routes.js";
import type { Principal } from "../auth/index.js";
import { HttpError, readJson, requestIdOf, send } from "../http.js";
import {
  ApplicationMissing,
  type DatabricksConfig,
  ProviderNotConfigured,
  type ProviderService,
} from "./service.js";

// A bare lower-case DNS name: no scheme, port, path or userinfo can ride along.
const HOST =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const WAREHOUSE_ID = /^[A-Za-z0-9]{1,64}$/;

const invalid = (message: string) =>
  new HttpError(400, "invalid_request", message);

function toConfig(v: unknown): DatabricksConfig {
  const c = v as Record<string, unknown> | null;
  if (
    typeof c !== "object" ||
    c === null ||
    // Unknown keys are refused so a credential cannot be stored by accident.
    Object.keys(c).some((k) => k !== "workspaceHost" && k !== "warehouseId") ||
    typeof c.workspaceHost !== "string" ||
    !HOST.test(c.workspaceHost) ||
    typeof c.warehouseId !== "string" ||
    !WAREHOUSE_ID.test(c.warehouseId)
  ) {
    throw invalid(
      "config must be {workspaceHost: bare host name, warehouseId: alphanumeric}.",
    );
  }
  return { workspaceHost: c.workspaceHost, warehouseId: c.warehouseId };
}

function translate(err: unknown): unknown {
  if (err instanceof ProviderNotConfigured) {
    return new HttpError(404, "not_found", "Provider is not configured.");
  }
  if (err instanceof ApplicationMissing) {
    return new HttpError(404, "not_found", "Application not found.");
  }
  return err;
}

/** Returns true if the request was handled. Business logic lives in the service. */
export function providerRoutes(service: ProviderService) {
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    principal: Principal,
    url: URL,
  ): Promise<boolean> => {
    if (url.pathname !== "/v1/providers/databricks") return false;
    try {
      if (req.method === "GET") {
        // The bound workload (scope `check`) may read its own settings, never change them.
        if (!principal.scopes.includes("check")) {
          requireScope(principal, "providers:read");
        }
        const application = applicationOf(url.searchParams.get("application"));
        permit(principal, application);
        send(res, 200, {
          application,
          provider: "databricks",
          config: await service.get(application),
        });
      } else if (req.method === "PUT") {
        requireScope(principal, "providers:write");
        const body = (await readJson(req)) as Record<string, unknown> | null;
        if (
          typeof body !== "object" ||
          body === null ||
          Object.keys(body).some((k) => k !== "application" && k !== "config")
        ) {
          throw invalid("Body must be {application, config}.");
        }
        const application = applicationOf(body.application);
        const config = toConfig(body.config);
        permit(principal, application);
        const auditEventId = await service.put(
          principal.subject,
          application,
          config,
          requestIdOf(res),
        );
        res.setHeader("riz-audit-event-id", auditEventId);
        res.statusCode = 204;
        res.end();
      } else if (req.method === "DELETE") {
        requireScope(principal, "providers:write");
        const application = applicationOf(url.searchParams.get("application"));
        permit(principal, application);
        const auditEventId = await service.remove(
          principal.subject,
          application,
          requestIdOf(res),
        );
        res.setHeader("riz-audit-event-id", auditEventId);
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
