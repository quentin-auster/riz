import type { IncomingMessage, ServerResponse } from "node:http";
import { ApplicationNotFound } from "../checks/resolver.js";
import { HttpError, readJson, requestIdOf, send } from "../http.js";
import type { Principal } from "./principal.js";
import type { BindingStore, WorkloadBinding } from "./workloads.js";

const APPLICATION = /^[a-z0-9][a-z0-9-]{0,62}$/;

function invalid() {
  return new HttpError(
    400,
    "invalid_request",
    "issuer, workload and application are required and must be valid.",
  );
}

function toBinding(b: Record<string, unknown>): WorkloadBinding {
  const { issuer, workload, application } = b;
  if (
    typeof issuer !== "string" ||
    issuer === "" ||
    issuer.length > 512 ||
    typeof workload !== "string" ||
    workload === "" ||
    workload.length > 256 ||
    typeof application !== "string" ||
    !APPLICATION.test(application)
  ) {
    throw invalid();
  }
  return { issuer, workload, application };
}

/** Returns true if the request was handled. */
export function workloadRoutes(store: BindingStore) {
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    principal: Principal,
    url: URL,
  ): Promise<boolean> => {
    if (url.pathname !== "/v1/workload-bindings") return false;
    const isPost = req.method === "POST";
    if (!isPost && req.method !== "DELETE") return false;

    if (!principal.scopes.includes("bindings:write")) {
      throw new HttpError(403, "forbidden", "Missing scope bindings:write.");
    }
    // Bindings decide which applications a workload reaches, so this is for platform administrators.
    if (!principal.applications.includes("*")) {
      throw new HttpError(
        403,
        "forbidden",
        "Changing bindings requires an all-applications allow-list.",
      );
    }

    try {
      if (isPost) {
        const body = await readJson(req);
        if (
          typeof body !== "object" ||
          body === null ||
          Array.isArray(body) ||
          Object.keys(body).some(
            (k) => !["issuer", "workload", "application"].includes(k),
          )
        ) {
          throw invalid();
        }
        const binding = toBinding(body as Record<string, unknown>);
        await store.bind(principal.subject, binding, requestIdOf(res));
        send(res, 201, binding);
      } else {
        const binding = toBinding({
          issuer: url.searchParams.get("issuer"),
          workload: url.searchParams.get("workload"),
          application: url.searchParams.get("application"),
        });
        await store.unbind(principal.subject, binding, requestIdOf(res));
        res.statusCode = 204;
        res.end();
      }
    } catch (err) {
      if (err instanceof ApplicationNotFound) {
        throw new HttpError(404, "not_found", "Application not found.");
      }
      throw err;
    }
    return true;
  };
}
