import { FgaApiValidationError } from "@openfga/sdk";
import type pg from "pg";
import type { createResolver } from "../checks/resolver.js";
import { HttpError } from "../http.js";
import { recordAudit } from "./audit.js";
import type { Page } from "./service.js";

export interface Relationship {
  subject: string;
  relation: string;
  object: string;
}

/** The tuple does not fit the application's pinned model, or the request is malformed. */
export class InvalidRelationship extends Error {}
export class RelationshipExists extends Error {}
export class RelationshipNotFound extends Error {}

type Resolver = ReturnType<typeof createResolver>;

const key = (r: Relationship) => ({
  user: r.subject,
  relation: r.relation,
  object: r.object,
});

/**
 * Runs an OpenFGA call. A validation error is the caller's (unknown type or relation,
 * duplicate, missing tuple); anything else is an outage and fails closed as 503.
 */
export async function fga<T>(
  call: () => Promise<T>,
  onInvalid: (message: string) => Error,
): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof FgaApiValidationError) {
      throw onInvalid(err.apiErrorMessage ?? "rejected by the model");
    }
    throw new HttpError(
      503,
      "authorization_unavailable",
      "The authorization store is unavailable.",
    );
  }
}

/**
 * Tuples live only in the application's OpenFGA store, written at its pinned model, which
 * is also what validates them: riz keeps no copy and no second validator.
 */
export function createRelationshipService(deps: {
  pool: pg.Pool;
  resolver: Resolver;
}) {
  const { pool, resolver } = deps;

  /**
   * The audit row is inserted first, inside a transaction that only commits once OpenFGA
   * accepted the change: if the audit store is down the mutation never happens.
   * shortcut: a COMMIT that fails after OpenFGA accepted leaves an unaudited change;
   * upgrade to an outbox or compensating write if that window matters.
   */
  async function audited(
    actor: string,
    application: string,
    action: string,
    detail: Record<string, unknown>,
    requestId: string | undefined,
    mutate: () => Promise<unknown>,
  ): Promise<string> {
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      const auditEventId = await recordAudit(db, {
        actor,
        action,
        applicationId: application,
        requestId,
        detail,
      });
      await mutate();
      await db.query("COMMIT");
      return auditEventId;
    } catch (err) {
      await db.query("ROLLBACK");
      throw err;
    } finally {
      db.release();
    }
  }

  return {
    async list(
      application: string,
      filter: { object?: string | undefined; relation?: string | undefined },
      page: { cursor?: string | undefined; limit: number },
    ): Promise<Page<Relationship>> {
      const client = await resolver.clientFor(application);
      const { tuples, continuation_token } = await fga(
        () =>
          client.read(
            {
              ...(filter.object ? { object: filter.object } : {}),
              ...(filter.relation ? { relation: filter.relation } : {}),
            },
            {
              pageSize: page.limit,
              ...(page.cursor ? { continuationToken: page.cursor } : {}),
            },
          ),
        (m) => new InvalidRelationship(m),
      );
      const items = tuples.map((t) => ({
        subject: t.key.user,
        relation: t.key.relation,
        object: t.key.object,
      }));
      return continuation_token
        ? { items, nextCursor: continuation_token }
        : { items };
    },

    async write(
      actor: string,
      application: string,
      relationships: Relationship[],
      requestId?: string,
    ): Promise<string> {
      const client = await resolver.clientFor(application);
      return audited(
        actor,
        application,
        "relationships.write",
        { before: null, after: relationships },
        requestId,
        () =>
          fga(
            () => client.write({ writes: relationships.map(key) }),
            (m) =>
              /already exist/i.test(m)
                ? new RelationshipExists(m)
                : new InvalidRelationship(m),
          ),
      );
    },

    async remove(
      actor: string,
      application: string,
      relationship: Relationship,
      requestId?: string,
    ): Promise<string> {
      const client = await resolver.clientFor(application);
      return audited(
        actor,
        application,
        "relationships.delete",
        { before: relationship, after: null },
        requestId,
        () =>
          fga(
            () => client.write({ deletes: [key(relationship)] }),
            (m) => new RelationshipNotFound(m),
          ),
      );
    },
  };
}

export type RelationshipService = ReturnType<typeof createRelationshipService>;
