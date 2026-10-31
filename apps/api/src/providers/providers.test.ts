import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { transformer } from "@openfga/syntax-transformer";
import pg from "pg";
import { createAdminService } from "../admin/service.js";
import type { Principal } from "../auth/index.js";
import { migrate } from "../db/migrate.js";
import { createApp } from "../server.js";
import { providerRoutes } from "./routes.js";
import { createProviderService } from "./service.js";

// Integration: needs Postgres and OpenFGA (to register applications). Unverified until run.
const url = process.env.RIZ_DATABASE_URL;
const apiUrl = process.env.OPENFGA_API_URL;
const opts = {
  skip: url && apiUrl ? false : "RIZ_DATABASE_URL and OPENFGA_API_URL not set",
};

const principals: Record<string, Principal> = {
  platform: {
    subject: "platform",
    scopes: ["providers:read", "providers:write"],
    applications: ["*"],
  },
  crmAdmin: {
    subject: "crm-admin",
    scopes: ["providers:read", "providers:write"],
    applications: ["crm-prod"],
  },
  // The bound workload: may read its settings, never change them.
  workload: {
    subject: "crm-app",
    scopes: ["check"],
    applications: ["crm-prod"],
  },
  noScopes: { subject: "nobody", scopes: [], applications: ["*"] },
};

const config = {
  workspaceHost: "dbc-1234.cloud.databricks.com",
  warehouseId: "abc123",
};

async function withApp(
  fn: (ctx: {
    call: (
      token: string,
      method: string,
      path: string,
      body?: unknown,
    ) => Promise<{
      status: number;
      body: Record<string, unknown>;
      audit: string | null;
    }>;
    pool: pg.Pool;
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
  const server = createApp({
    readiness: async () => [],
    log: () => {},
    authenticate: (h) => principals[h?.replace("Bearer ", "") ?? ""] ?? null,
    routes: providerRoutes(createProviderService({ pool })),
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
    const call = async (
      token: string,
      method: string,
      path: string,
      body?: unknown,
    ) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return {
        status: res.status,
        body: await res.json().catch(() => ({})),
        audit: res.headers.get("riz-audit-event-id"),
      };
    };
    await fn({ call, pool });
  } finally {
    server.close();
    await pool.end();
    await setup.query(`DROP SCHEMA ${schema} CASCADE`);
    await setup.end();
  }
}

const P = "/v1/providers/databricks";
const crm = `${P}?application=crm-prod`;

test(
  "an admin stores provider settings, the bound workload reads them, and each change is audited",
  opts,
  () =>
    withApp(async ({ call, pool }) => {
      const put = await call("platform", "PUT", P, {
        application: "crm-prod",
        config,
      });
      assert.equal(put.status, 204);
      assert.ok(put.audit);

      const got = await call("workload", "GET", crm);
      assert.equal(got.status, 200);
      assert.deepEqual(got.body.config, config);

      const del = await call("platform", "DELETE", crm);
      assert.equal(del.status, 204);
      assert.equal((await call("workload", "GET", crm)).status, 404);

      const { rows } = await pool.query(
        "SELECT action, actor FROM audit_events WHERE action LIKE 'providers.%' ORDER BY id",
      );
      assert.deepEqual(
        rows.map((r) => r.action),
        ["providers.put", "providers.delete"],
      );
    }),
);

test("the bound workload cannot change or remove provider settings", opts, () =>
  withApp(async ({ call, pool }) => {
    const put = await call("workload", "PUT", P, {
      application: "crm-prod",
      config,
    });
    assert.equal(put.status, 403);
    assert.equal((await call("workload", "DELETE", crm)).status, 403);
    const { rows } = await pool.query("SELECT 1 FROM provider_configs");
    assert.equal(rows.length, 0);
  }),
);

test(
  "a caller outside the application allow-list is refused whether or not it exists",
  opts,
  () =>
    withApp(async ({ call }) => {
      for (const application of ["hr-prod", "ghost-prod"]) {
        const put = await call("crmAdmin", "PUT", P, { application, config });
        assert.equal(put.status, 403);
        const get = await call(
          "crmAdmin",
          "GET",
          `${P}?application=${application}`,
        );
        assert.equal(get.status, 403);
      }
      assert.equal((await call("noScopes", "GET", crm)).status, 403);
    }),
);

test(
  "credentials, URLs and unknown fields are refused and nothing is stored",
  opts,
  () =>
    withApp(async ({ call, pool }) => {
      for (const bad of [
        { ...config, token: "dapi-secret" },
        { ...config, workspaceHost: "https://dbc-1234.cloud.databricks.com" },
        { ...config, workspaceHost: "user:pw@evil.example.com" },
        { ...config, workspaceHost: "evil.example.com/path" },
        { ...config, workspaceHost: "localhost" },
        { workspaceHost: config.workspaceHost },
      ]) {
        const res = await call("platform", "PUT", P, {
          application: "crm-prod",
          config: bad,
        });
        assert.equal(res.status, 400, JSON.stringify(bad));
      }
      assert.equal(
        (await pool.query("SELECT 1 FROM provider_configs")).rows.length,
        0,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM audit_events WHERE action = 'providers.put'",
          )
        ).rows.length,
        0,
      );
    }),
);

test(
  "putting settings for an unknown application is 404 and leaves no audit row",
  opts,
  () =>
    withApp(async ({ call, pool }) => {
      const res = await call("platform", "PUT", P, {
        application: "ghost-prod",
        config,
      });
      assert.equal(res.status, 404);
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM audit_events WHERE action = 'providers.put'",
          )
        ).rows.length,
        0,
      );
    }),
);

test(
  "replacing settings overwrites them, and deleting absent settings is 404",
  opts,
  () =>
    withApp(async ({ call }) => {
      assert.equal((await call("platform", "DELETE", crm)).status, 404);
      await call("platform", "PUT", P, { application: "crm-prod", config });
      const next = { ...config, warehouseId: "def456" };
      await call("platform", "PUT", P, {
        application: "crm-prod",
        config: next,
      });
      assert.deepEqual((await call("platform", "GET", crm)).body.config, next);
    }),
);
