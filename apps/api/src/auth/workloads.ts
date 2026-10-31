import type pg from "pg";
import { recordAudit } from "../admin/audit.js";
import { ApplicationNotFound } from "../checks/resolver.js";
import type { TokenVerifier } from "./oidc.js";
import type { Authenticator, EndUserVerifier } from "./principal.js";

export interface WorkloadBinding {
  issuer: string;
  workload: string;
  application: string;
}

/** Application IDs a workload is bound to. */
export type BindingLookup = (
  issuer: string,
  workload: string,
) => Promise<string[]>;

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v !== "";

/**
 * Authenticates a workload by its verified OIDC token. It is granted `check`
 * and nothing else (least privilege), on only the applications bound to it.
 */
export function workloadAuthenticator(
  verify: TokenVerifier,
  lookup: BindingLookup,
): Authenticator {
  return async (authorization) => {
    const token = /^Bearer (\S+)$/.exec(authorization ?? "")?.[1];
    if (!token) return null;
    const verified = await verify(token);
    if (!verified) return null;
    const { azp, client_id: clientId } = verified.claims;
    const workload = [azp, clientId].find(nonEmpty) ?? verified.subject;
    return {
      subject: `${verified.issuer}|${workload}`,
      scopes: ["check"],
      applications: await lookup(verified.issuer, workload),
      clientId: workload,
    };
  };
}

/**
 * The end user is the token's verified `sub`, and only if the token was issued
 * to the calling workload (`azp`), so another workload cannot replay it.
 */
export function oidcEndUserVerifier(verify: TokenVerifier): EndUserVerifier {
  return async (token, caller) => {
    if (!token || !caller.clientId) return null;
    const verified = await verify(token);
    if (!verified || verified.claims.azp !== caller.clientId) return null;
    return verified.subject;
  };
}

export function createBindingStore(pool: pg.Pool) {
  async function audited(
    actor: string,
    action: string,
    b: WorkloadBinding,
    sql: string,
    bound: boolean,
    requestId: string | undefined,
  ): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rowCount } = await client.query(sql, [
        b.issuer,
        b.workload,
        b.application,
      ]);
      // An idempotent repeat changes nothing, so it is not an event.
      if (rowCount) {
        const binding = { issuer: b.issuer, workload: b.workload };
        await recordAudit(client, {
          actor,
          action,
          applicationId: b.application,
          requestId,
          detail: bound
            ? { before: null, after: binding }
            : { before: binding, after: null },
        });
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      if ((err as { code?: string }).code === "23503") {
        throw new ApplicationNotFound(b.application);
      }
      throw err;
    } finally {
      client.release();
    }
  }

  return {
    lookup: (async (issuer, workload) => {
      const { rows } = await pool.query<{ application_id: string }>(
        "SELECT application_id FROM workload_bindings WHERE issuer = $1 AND workload = $2",
        [issuer, workload],
      );
      return rows.map((r) => r.application_id);
    }) satisfies BindingLookup,

    bind: (actor: string, b: WorkloadBinding, requestId?: string) =>
      audited(
        actor,
        "workloads.bind",
        b,
        `INSERT INTO workload_bindings (issuer, workload, application_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        true,
        requestId,
      ),

    unbind: (actor: string, b: WorkloadBinding, requestId?: string) =>
      audited(
        actor,
        "workloads.unbind",
        b,
        `DELETE FROM workload_bindings
          WHERE issuer = $1 AND workload = $2 AND application_id = $3`,
        false,
        requestId,
      ),
  };
}

export type BindingStore = ReturnType<typeof createBindingStore>;
