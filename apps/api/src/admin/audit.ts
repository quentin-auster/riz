import type pg from "pg";
import { InvalidCursor, type Page, type PageParams } from "./service.js";

export interface AuditEvent {
  actor: string;
  action: string;
  applicationId?: string | undefined;
  requestId?: string | undefined;
  /** Before/after summary. Never tokens or protected data. */
  detail?: Record<string, unknown>;
}

export interface AuditRecord {
  id: string;
  time: string;
  actor: string;
  action: string;
  application?: string;
  outcome: string;
  requestId?: string;
  detail: Record<string, unknown>;
}

/**
 * Appends an event on the mutation's own connection, so the mutation and its audit row
 * commit together: if this throws, the caller's transaction must roll back.
 */
export async function recordAudit(
  db: Pick<pg.PoolClient, "query">,
  e: AuditEvent,
): Promise<string> {
  const { rows } = await db.query(
    `INSERT INTO audit_events (actor, action, application_id, outcome, request_id, detail)
     VALUES ($1, $2, $3, 'success', $4, $5)
     RETURNING id`,
    [
      e.actor,
      e.action,
      e.applicationId ?? null,
      e.requestId ?? null,
      e.detail ?? {},
    ],
  );
  return String(rows[0].id);
}

export interface AuditFilter {
  application?: string | undefined;
  /** Inclusive. */
  from?: Date | undefined;
  /** Exclusive. */
  to?: Date | undefined;
}

/**
 * Newest first. `allowed` is the caller's application allow-list (`*` sees every event);
 * the filter only narrows it, so asking for another application returns nothing.
 */
export async function listAudit(
  pool: pg.Pool,
  allowed: readonly string[],
  page: PageParams,
  filter: AuditFilter = {},
): Promise<Page<AuditRecord>> {
  const before = page.cursor
    ? Buffer.from(page.cursor, "base64url").toString()
    : null;
  if (before !== null && !/^\d{1,18}$/.test(before)) throw new InvalidCursor();

  const { rows } = await pool.query(
    `SELECT id, time, actor, action, application_id, outcome, request_id, detail
       FROM audit_events
      WHERE ($1::boolean OR application_id = ANY($2))
        AND ($3::bigint IS NULL OR id < $3)
        AND ($5::text IS NULL OR application_id = $5)
        AND ($6::timestamptz IS NULL OR time >= $6)
        AND ($7::timestamptz IS NULL OR time < $7)
      ORDER BY id DESC LIMIT $4`,
    [
      allowed.includes("*"),
      allowed,
      before,
      page.limit + 1,
      filter.application ?? null,
      filter.from ?? null,
      filter.to ?? null,
    ],
  );
  const kept = rows.slice(0, page.limit);
  const items = kept.map((r) => ({
    id: String(r.id),
    time: r.time.toISOString(),
    actor: r.actor,
    action: r.action,
    ...(r.application_id ? { application: r.application_id } : {}),
    outcome: r.outcome,
    ...(r.request_id ? { requestId: r.request_id } : {}),
    detail: r.detail,
  }));
  const last = items.at(-1);
  return rows.length > page.limit && last
    ? { items, nextCursor: Buffer.from(last.id).toString("base64url") }
    : { items };
}
