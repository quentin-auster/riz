import type pg from "pg";
import { recordAudit } from "../admin/audit.js";

export interface DatabricksConfig {
  workspaceHost: string;
  warehouseId: string;
}

export class ProviderNotConfigured extends Error {}
export class ApplicationMissing extends Error {}

const FOREIGN_KEY_VIOLATION = "23503";

/**
 * Non-secret provider settings per application. Each mutation and its audit row commit
 * in one transaction, so an unaudited change cannot happen.
 */
export function createProviderService(deps: { pool: pg.Pool }) {
  const { pool } = deps;

  async function audited<T>(
    event: Parameters<typeof recordAudit>[1],
    mutate: (db: pg.PoolClient) => Promise<T>,
  ): Promise<{ auditEventId: string; result: T }> {
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      const auditEventId = await recordAudit(db, event);
      const result = await mutate(db);
      await db.query("COMMIT");
      return { auditEventId, result };
    } catch (err) {
      await db.query("ROLLBACK");
      throw err;
    } finally {
      db.release();
    }
  }

  return {
    async get(application: string): Promise<DatabricksConfig> {
      const { rows } = await pool.query(
        `SELECT config FROM provider_configs
          WHERE application_id = $1 AND provider = 'databricks'`,
        [application],
      );
      if (rows.length === 0) throw new ProviderNotConfigured();
      return rows[0].config as DatabricksConfig;
    },

    async put(
      actor: string,
      application: string,
      config: DatabricksConfig,
      requestId?: string,
    ): Promise<string> {
      try {
        const { auditEventId } = await audited(
          {
            actor,
            action: "providers.put",
            applicationId: application,
            requestId,
            detail: { provider: "databricks", config },
          },
          (db) =>
            db.query(
              `INSERT INTO provider_configs (application_id, provider, config)
               VALUES ($1, 'databricks', $2)
               ON CONFLICT (application_id, provider) DO UPDATE SET config = EXCLUDED.config`,
              [application, config],
            ),
        );
        return auditEventId;
      } catch (err) {
        // The audit row references the application too, so either insert can raise this.
        if ((err as { code?: string }).code === FOREIGN_KEY_VIOLATION) {
          throw new ApplicationMissing();
        }
        throw err;
      }
    },

    async remove(
      actor: string,
      application: string,
      requestId?: string,
    ): Promise<string> {
      const { auditEventId } = await audited(
        {
          actor,
          action: "providers.delete",
          applicationId: application,
          requestId,
          detail: { provider: "databricks" },
        },
        async (db) => {
          const { rowCount } = await db.query(
            `DELETE FROM provider_configs
              WHERE application_id = $1 AND provider = 'databricks'`,
            [application],
          );
          // Throwing rolls the audit row back: nothing changed, so nothing to record.
          if (rowCount === 0) throw new ProviderNotConfigured();
        },
      );
      return auditEventId;
    },
  };
}

export type ProviderService = ReturnType<typeof createProviderService>;
