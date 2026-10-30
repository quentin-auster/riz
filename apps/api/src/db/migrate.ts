import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "pg";

const MIGRATIONS_DIR = join(import.meta.dirname, "../../migrations");
// Arbitrary constant: serializes concurrent runners (for example several replicas starting).
const LOCK_ID = 7_201_001;

/**
 * Applies every unapplied `migrations/*.sql` in filename order, each in its own
 * transaction, and returns the versions it applied. Re-running is a no-op.
 * Applied migrations are never edited; changes go in a new file.
 */
export async function migrate(client: Client): Promise<string[]> {
  await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const done = new Set(
      (
        await client.query<{ version: string }>(
          "SELECT version FROM schema_migrations",
        )
      ).rows.map((r) => r.version),
    );
    const applied: string[] = [];
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const file of files) {
      if (done.has(file)) continue;
      await client.query("BEGIN");
      try {
        // Fail fast rather than queue behind a long query and block all traffic.
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
        await client.query(
          "INSERT INTO schema_migrations (version) VALUES ($1)",
          [file],
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${file} failed`, { cause: err });
      }
      applied.push(file);
    }
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]);
  }
}
