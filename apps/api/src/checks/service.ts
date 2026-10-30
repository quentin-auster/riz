import { FgaApiValidationError, type OpenFgaClient } from "@openfga/sdk";
import {
  ApplicationNotFound,
  type createResolver,
  NoActiveModel,
} from "./resolver.js";

export type Decision = "allow" | "deny" | "indeterminate";

export interface CheckResult {
  status: Decision;
  modelId?: string;
  /** Why the decision is indeterminate; absent otherwise. */
  code?: "timeout" | "backend_error" | "no_active_model";
}

/** The request is malformed for this application's model (unknown type or relation). */
export class InvalidCheck extends Error {}

class Timeout extends Error {}

/**
 * Checks one permission for `user:<endUser>` in the application's store against
 * its pinned model. Any failure to reach a decision is `indeterminate`, never allow.
 */
export function createCheckService(deps: {
  resolver: ReturnType<typeof createResolver>;
  timeoutMs: number;
}) {
  const { resolver, timeoutMs } = deps;

  return {
    async check(
      applicationId: string,
      endUser: string,
      input: { relation: string; object: string },
    ): Promise<CheckResult> {
      let client: OpenFgaClient;
      try {
        client = await resolver.clientFor(applicationId);
      } catch (err) {
        if (err instanceof ApplicationNotFound) throw err;
        if (err instanceof NoActiveModel) {
          return { status: "indeterminate", code: "no_active_model" };
        }
        // Database failure: no decision can be made.
        return { status: "indeterminate", code: "backend_error" };
      }

      let timer: NodeJS.Timeout | undefined;
      try {
        // shortcut: on timeout the OpenFGA request is abandoned, not cancelled
        // (the SDK takes no abort signal); upgrade if abandoned calls pile up.
        const { allowed } = await Promise.race([
          client.check(
            {
              user: `user:${endUser}`,
              relation: input.relation,
              object: input.object,
            },
            { retryParams: { maxRetry: 0 } },
          ),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Timeout()), timeoutMs);
          }),
        ]);
        return {
          status: allowed === true ? "allow" : "deny",
          // clientFor always pins a model ID.
          modelId: client.authorizationModelId as string,
        };
      } catch (err) {
        if (err instanceof FgaApiValidationError) throw new InvalidCheck();
        return {
          status: "indeterminate",
          code: err instanceof Timeout ? "timeout" : "backend_error",
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export type CheckService = ReturnType<typeof createCheckService>;
