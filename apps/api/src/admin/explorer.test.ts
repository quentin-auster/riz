import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { transformer } from "@openfga/syntax-transformer";
import pg from "pg";
import type { Principal } from "../auth/index.js";
import { createResolver, dbLookup } from "../checks/resolver.js";
import { createCheckService } from "../checks/service.js";
import { migrate } from "../db/migrate.js";
import { createApp } from "../server.js";
import { explorerRoutes } from "./explorerRoutes.js";
import { createRelationshipService } from "./relationships.js";
import { createAdminService } from "./service.js";

// Integration: needs Postgres and OpenFGA. Unverified until run against both.
const url = process.env.RIZ_DATABASE_URL;
const apiUrl = process.env.OPENFGA_API_URL;
const opts = {
  skip: url && apiUrl ? false : "RIZ_DATABASE_URL and OPENFGA_API_URL not set",
};

const principals: Record<string, Principal> = {
  platform: {
    subject: "platform",
    scopes: ["explorer:check"],
    applications: ["*"],
  },
  crmAdmin: {
    subject: "crm-admin",
    scopes: ["explorer:check"],
    applications: ["crm-prod"],
  },
  // A workload that may run ordinary checks, but not name another principal.
  checker: {
    subject: "checker",
    scopes: ["check", "relationships:read"],
    applications: ["*"],
  },
};

const query = {
  application: "crm-prod",
  principal: "anne",
  relation: "member",
  object: "team:eng",
};

async function withApp(
  fn: (ctx: {
    call: (
      token: string,
      body: unknown,
    ) => Promise<{ status: number; body: Record<string, unknown> }>;
    pool: pg.Pool;
    grant: () => Promise<void>;
  }) => Promise<void>,
) {
  const schema = `t_${randomUUID().replaceAll("-", "")}`;
  const setup = new pg.Client({ connectionString: url });
  await setup.connect();
  await setup.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({
    connectionString: url,
    options: `-c search_path=${schema}`,
  });
  const resolver = createResolver(dbLookup(pool), apiUrl as string);
  const server = createApp({
    readiness: async () => [],
    log: () => {},
    authenticate: (h) => principals[h?.replace("Bearer ", "") ?? ""] ?? null,
    routes: explorerRoutes({
      pool,
      checks: createCheckService({ resolver, timeoutMs: 2000 }),
    }),
  });
  try {
    const c = await pool.connect();
    await migrate(c);
    c.release();
    const admin = createAdminService({
      pool,
      apiUrl: apiUrl as string,
      baseModel: transformer.transformDSLToJSONObject(
        readFileSync(
          join(import.meta.dirname, "../../../../models/openfga/base.fga"),
          "utf8",
        ),
      ),
    });
    for (const name of ["crm", "hr"]) {
      await admin.register("platform", { name, environment: "prod" });
    }
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    const call = async (token: string, body: unknown) => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/explorer/check`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    };
    const grant = () =>
      createRelationshipService({ pool, resolver })
        .write(
          "platform",
          "crm-prod",
          [{ subject: "user:anne", relation: "member", object: "team:eng" }],
          undefined,
        )
        .then(() => undefined);
    await fn({ call, pool, grant });
  } finally {
    server.close();
    await pool.end();
    await setup.query(`DROP SCHEMA ${schema} CASCADE`);
    await setup.end();
  }
}

const audited = async (pool: pg.Pool) =>
  (
    await pool.query(
      "SELECT actor, application_id, detail FROM audit_events WHERE action = 'explorer.check'",
    )
  ).rows;

test(
  "an admin learns whether another principal is allowed, and the query is audited",
  opts,
  () =>
    withApp(async ({ call, pool, grant }) => {
      const before = await call("platform", query);
      assert.equal(before.status, 200);
      assert.equal(before.body.status, "deny");

      await grant();
      const after = await call("platform", query);
      assert.equal(after.status, 200);
      assert.equal(after.body.status, "allow");
      assert.equal(typeof after.body.modelId, "string");
      assert.equal(typeof after.body.requestId, "string");

      const rows = await audited(pool);
      assert.equal(rows.length, 2);
      assert.equal(rows[1].actor, "platform");
      assert.equal(rows[1].application_id, "crm-prod");
      assert.deepEqual(rows[1].detail, {
        principal: "anne",
        relation: "member",
        object: "team:eng",
        decision: "allow",
      });
    }),
);

test(
  "a caller without the explorer scope, or outside the application, cannot query as another principal",
  opts,
  () =>
    withApp(async ({ call, pool, grant }) => {
      await grant();
      // `check` scope is for asking about the end user's own token, not for naming one.
      assert.equal((await call("checker", query)).status, 403);
      assert.equal(
        (await call("crmAdmin", { ...query, application: "hr-prod" })).status,
        403,
      );
      // Same answer whether or not the application exists.
      assert.equal(
        (await call("crmAdmin", { ...query, application: "nope-prod" })).status,
        403,
      );
      assert.deepEqual(await audited(pool), []);
    }),
);

test("a malformed query is rejected before any check", opts, () =>
  withApp(async ({ call, pool }) => {
    for (const bad of [
      { ...query, principal: "anne#member" },
      { ...query, object: "team" },
      { ...query, extra: 1 },
      { application: "crm-prod" },
    ]) {
      assert.equal((await call("platform", bad)).status, 400);
    }
    assert.deepEqual(await audited(pool), []);
  }),
);
