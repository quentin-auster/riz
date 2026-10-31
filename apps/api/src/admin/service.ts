import { OpenFgaClient } from "@openfga/sdk";
import type { transformer } from "@openfga/syntax-transformer";
import type pg from "pg";
import { ApplicationNotFound } from "../checks/resolver.js";
import { type AuditFilter, listAudit, recordAudit } from "./audit.js";

type ModelJson = ReturnType<typeof transformer.transformDSLToJSONObject>;

export class ApplicationExists extends Error {}
export class InvalidCursor extends Error {}

export interface Application {
  id: string;
  name: string;
  environment: string;
  createdAt: string;
}

export interface ModelEntry {
  id: string;
  createdAt: string;
  active: boolean;
}

export interface PageParams {
  cursor?: string | undefined;
  limit: number;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

/** Application IDs a caller may reach; `*` means all (platform administrators). */
type Allowed = readonly string[];

const encode = (v: string) => Buffer.from(v).toString("base64url");
const decode = (v: string | undefined) =>
  v ? Buffer.from(v, "base64url").toString() : "";

export function createAdminService(deps: {
  pool: pg.Pool;
  apiUrl: string;
  baseModel: ModelJson;
}) {
  const { pool, apiUrl, baseModel } = deps;

  async function get(id: string, allowed: Allowed): Promise<Application> {
    const { rows } = await pool.query(
      "SELECT id, name, environment, created_at FROM applications WHERE id = $1",
      [id],
    );
    // Unknown and not-allow-listed look the same, so existence is not leaked.
    if (!rows[0] || !(allowed.includes("*") || allowed.includes(id))) {
      throw new ApplicationNotFound(id);
    }
    return toApplication(rows[0]);
  }

  return {
    get,

    async register(
      actor: string,
      input: { name: string; environment: string },
      requestId?: string,
    ): Promise<Application> {
      const id = `${input.name}-${input.environment}`;
      const existing = await pool.query(
        "SELECT 1 FROM applications WHERE id = $1",
        [id],
      );
      if (existing.rowCount) throw new ApplicationExists(id);

      const { id: storeId } = await new OpenFgaClient({ apiUrl }).createStore({
        name: id,
      });
      const { authorization_model_id: modelId } = await new OpenFgaClient({
        apiUrl,
        storeId,
      }).writeAuthorizationModel(baseModel);
      if (!modelId) {
        throw new Error("OpenFGA did not return an authorization_model_id");
      }

      // shortcut: a failure from here on leaves an orphan OpenFGA store; add
      // cleanup or reconciliation when provisioning needs to be recoverable.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows } = await client.query(
          `INSERT INTO applications (id, name, environment, store_id)
           VALUES ($1, $2, $3, $4)
           RETURNING id, name, environment, created_at`,
          [id, input.name, input.environment, storeId],
        );
        await client.query(
          "INSERT INTO model_bindings (application_id, model_id, active) VALUES ($1, $2, true)",
          [id, modelId],
        );
        await recordAudit(client, {
          actor,
          action: "applications.create",
          applicationId: id,
          requestId,
          detail: { before: null, after: input },
        });
        await client.query("COMMIT");
        return toApplication(rows[0]);
      } catch (err) {
        await client.query("ROLLBACK");
        // A concurrent registration of the same application.
        if ((err as { code?: string }).code === "23505") {
          throw new ApplicationExists(id);
        }
        throw err;
      } finally {
        client.release();
      }
    },

    async list(allowed: Allowed, page: PageParams): Promise<Page<Application>> {
      const { rows } = await pool.query(
        `SELECT id, name, environment, created_at FROM applications
          WHERE ($1::boolean OR id = ANY($2)) AND id > $3
          ORDER BY id LIMIT $4`,
        [allowed.includes("*"), allowed, decode(page.cursor), page.limit + 1],
      );
      const items = rows.slice(0, page.limit).map(toApplication);
      const last = items.at(-1);
      return rows.length > page.limit && last
        ? { items, nextCursor: encode(last.id) }
        : { items };
    },

    audit: (allowed: Allowed, page: PageParams, filter?: AuditFilter) =>
      listAudit(pool, allowed, page, filter),

    async models(
      applicationId: string,
      allowed: Allowed,
      page: PageParams,
    ): Promise<Page<ModelEntry>> {
      await get(applicationId, allowed);
      const after = decode(page.cursor) || "0";
      if (!/^\d{1,18}$/.test(after)) throw new InvalidCursor();
      const { rows } = await pool.query(
        `SELECT id, model_id, active, bound_at FROM model_bindings
          WHERE application_id = $1 AND id > $2
          ORDER BY id LIMIT $3`,
        [applicationId, after, page.limit + 1],
      );
      const kept = rows.slice(0, page.limit);
      const items = kept.map((r) => ({
        id: r.model_id,
        createdAt: r.bound_at.toISOString(),
        active: r.active,
      }));
      const last = kept.at(-1);
      return rows.length > page.limit && last
        ? { items, nextCursor: encode(String(last.id)) }
        : { items };
    },
  };
}

export type AdminService = ReturnType<typeof createAdminService>;

function toApplication(row: {
  id: string;
  name: string;
  environment: string;
  created_at: Date;
}): Application {
  return {
    id: row.id,
    name: row.name,
    environment: row.environment,
    createdAt: row.created_at.toISOString(),
  };
}
