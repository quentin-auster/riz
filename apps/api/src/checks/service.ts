import {
  ConsistencyPreference,
  FgaApiValidationError,
  type OpenFgaClient,
} from "@openfga/sdk";
import {
  ApplicationNotFound,
  type createResolver,
  NoActiveModel,
} from "./resolver.js";

/** Absent means OpenFGA's own default, which is `minimize_latency`. */
export type Consistency = "minimize_latency" | "higher_consistency";

export type Decision = "allow" | "deny" | "indeterminate";
export type IndeterminateCode = "timeout" | "backend_error" | "no_active_model";

export interface CheckResult {
  status: Decision;
  modelId?: string;
  /** Why the decision is indeterminate; absent otherwise. */
  code?: IndeterminateCode;
}

export interface BatchItem {
  correlationId: string;
  relation: string;
  object: string;
}

export interface BatchResult {
  modelId?: string;
  results: { correlationId: string; status: Decision }[];
}

/** The request is malformed for this application's model (unknown type or relation). */
export class InvalidCheck extends Error {}

class Timeout extends Error {}

/**
 * Checks permissions for `user:<endUser>` in the application's store against
 * its pinned model. Any failure to reach a decision is `indeterminate`, never allow.
 */
export function createCheckService(deps: {
  resolver: ReturnType<typeof createResolver>;
  timeoutMs: number;
}) {
  const { resolver, timeoutMs } = deps;

  /**
   * Runs `call` against the application's pinned client under the timeout.
   * `fail` builds the answer when no decision can be made.
   */
  async function guarded<T>(
    applicationId: string,
    call: (client: OpenFgaClient, modelId: string) => Promise<T>,
    fail: (code: IndeterminateCode) => T,
  ): Promise<T> {
    let client: OpenFgaClient;
    try {
      client = await resolver.clientFor(applicationId);
    } catch (err) {
      if (err instanceof ApplicationNotFound) throw err;
      if (err instanceof NoActiveModel) return fail("no_active_model");
      // Database failure: no decision can be made.
      return fail("backend_error");
    }

    let timer: NodeJS.Timeout | undefined;
    try {
      // shortcut: on timeout the OpenFGA request is abandoned, not cancelled
      // (the SDK takes no abort signal); upgrade if abandoned calls pile up.
      return await Promise.race([
        // clientFor always pins a model ID.
        call(client, client.authorizationModelId as string),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Timeout()), timeoutMs);
        }),
      ]);
    } catch (err) {
      if (err instanceof FgaApiValidationError) throw new InvalidCheck();
      return fail(err instanceof Timeout ? "timeout" : "backend_error");
    } finally {
      clearTimeout(timer);
    }
  }

  const requestOptions = (consistency: Consistency | undefined) => ({
    retryParams: { maxRetry: 0 },
    ...(consistency === undefined
      ? {}
      : {
          consistency:
            consistency === "higher_consistency"
              ? ConsistencyPreference.HigherConsistency
              : ConsistencyPreference.MinimizeLatency,
        }),
  });

  return {
    check(
      applicationId: string,
      endUser: string,
      input: {
        relation: string;
        object: string;
        consistency?: Consistency | undefined;
      },
    ): Promise<CheckResult> {
      return guarded<CheckResult>(
        applicationId,
        async (client, modelId) => {
          const { allowed } = await client.check(
            {
              user: `user:${endUser}`,
              relation: input.relation,
              object: input.object,
            },
            requestOptions(input.consistency),
          );
          return { status: allowed === true ? "allow" : "deny", modelId };
        },
        (code) => ({ status: "indeterminate", code }),
      );
    },

    /** One result per item, matched to OpenFGA's answers by correlation ID. */
    batch(
      applicationId: string,
      endUser: string,
      items: BatchItem[],
      consistency?: Consistency,
    ): Promise<BatchResult> {
      const allIndeterminate = (): BatchResult => ({
        results: items.map((i) => ({
          correlationId: i.correlationId,
          status: "indeterminate",
        })),
      });
      return guarded<BatchResult>(
        applicationId,
        async (client, modelId) => {
          const { result } = await client.batchCheck(
            {
              checks: items.map((i) => ({
                user: `user:${endUser}`,
                relation: i.relation,
                object: i.object,
                correlationId: i.correlationId,
              })),
            },
            requestOptions(consistency),
          );
          const byId = new Map(result.map((r) => [r.correlationId, r]));
          return {
            modelId,
            results: items.map((i) => {
              const r = byId.get(i.correlationId);
              // A missing answer or a per-item error is not a decision.
              const status: Decision =
                !r || r.error ? "indeterminate" : r.allowed ? "allow" : "deny";
              return { correlationId: i.correlationId, status };
            }),
          };
        },
        allIndeterminate,
      );
    },
  };
}

export type CheckService = ReturnType<typeof createCheckService>;
