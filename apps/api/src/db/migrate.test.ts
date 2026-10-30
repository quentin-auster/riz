import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { migrate } from "./migrate.js";

// Integration: needs Postgres (RIZ_DATABASE_URL). Unverified until run against one.
const url = process.env.RIZ_DATABASE_URL;
const opts = { skip: url ? false : "RIZ_DATABASE_URL not set" };

// Each test runs in its own schema so it starts from an empty database.
async function withSchema(fn: (client: pg.Client) => Promise<void>) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const schema = `t_${randomUUID().replaceAll("-", "")}`;
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await fn(client);
  } finally {
    await client.query(`DROP SCHEMA ${schema} CASCADE`);
    await client.end();
  }
}

const addApp = (client: pg.Client) =>
  client.query(
    "INSERT INTO applications (id, name, environment, store_id) VALUES ('crm-prod', 'crm', 'prod', 's1')",
  );

test("applies to an empty database and re-running is a no-op", opts, () =>
  withSchema(async (client) => {
    const first = await migrate(client);
    assert.ok(first.length > 0);
    assert.deepEqual(await migrate(client), []);
  }),
);

test("rejects updating or deleting audit events", opts, () =>
  withSchema(async (client) => {
    await migrate(client);
    await client.query(
      "INSERT INTO audit_events (actor, action, outcome) VALUES ('a', 'x', 'success')",
    );
    await assert.rejects(
      client.query("UPDATE audit_events SET actor = 'b'"),
      /append-only/,
    );
    await assert.rejects(
      client.query("DELETE FROM audit_events"),
      /append-only/,
    );
    await assert.rejects(client.query("TRUNCATE audit_events"), /append-only/);
  }),
);

test("allows only one active model binding per application", opts, () =>
  withSchema(async (client) => {
    await migrate(client);
    await addApp(client);
    const bind = (model: string, active: boolean) =>
      client.query(
        "INSERT INTO model_bindings (application_id, model_id, active) VALUES ('crm-prod', $1, $2)",
        [model, active],
      );
    await bind("m1", true);
    await bind("m0", false);
    await assert.rejects(bind("m2", true), /model_bindings_one_active/);
  }),
);

test("rejects an application id that is not name-environment", opts, () =>
  withSchema(async (client) => {
    await migrate(client);
    await assert.rejects(
      client.query(
        "INSERT INTO applications (id, name, environment, store_id) VALUES ('other', 'crm', 'prod', 's1')",
      ),
      /check constraint/,
    );
  }),
);
