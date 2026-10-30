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
import { migrate } from "../db/migrate.js";
import { createApp } from "../server.js";
import { adminRoutes } from "./routes.js";
import { createAdminService } from "./service.js";

// Integration: needs Postgres and OpenFGA. Unverified until run against both.
const url = process.env.RIZ_DATABASE_URL;
const apiUrl = process.env.OPENFGA_API_URL;
const opts = {
  skip: url && apiUrl ? false : "RIZ_DATABASE_URL and OPENFGA_API_URL not set",
};

const ALL = ["applications:read", "applications:write", "models:read"];
const principals: Record<string, Principal> = {
  admin: { subject: "admin", scopes: ALL, applications: ["*"] },
  crmOnly: { subject: "crm", scopes: ALL, applications: ["crm-prod"] },
  noScope: { subject: "ns", scopes: [], applications: ["*"] },
};

type Call = (
  token: string,
  method: string,
  path: string,
  body?: unknown,
) => Promise<{ status: number; body: Json }>;

// Only the fields these tests read; a wrong shape fails the assertion, not the type.
type Json = { id: string; items: { id: string; active: boolean }[] };

async function withApp(
  fn: (
    call: Call,
    pool: pg.Pool,
    lookup: ReturnType<typeof dbLookup>,
  ) => Promise<void>,
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
    routes: adminRoutes(
      createAdminService({
        pool,
        apiUrl: apiUrl as string,
        baseModel: transformer.transformDSLToJSONObject(
          readFileSync(
            join(import.meta.dirname, "../../../../models/openfga/base.fga"),
            "utf8",
          ),
        ),
      }),
    ),
  });
  try {
    const c = await pool.connect();
    await migrate(c);
    c.release();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    const call: Call = async (token, method, path, body) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    await fn(call, pool, dbLookup(pool));
  } finally {
    server.close();
    await pool.end();
    await setup.query(`DROP SCHEMA ${schema} CASCADE`);
    await setup.end();
  }
}

test(
  "registering two applications yields distinct stores and bindings",
  opts,
  () =>
    withApp(async (call, pool, lookup) => {
      const crm = await call("admin", "POST", "/v1/applications", {
        name: "crm",
        environment: "prod",
      });
      const hr = await call("admin", "POST", "/v1/applications", {
        name: "hr",
        environment: "prod",
      });
      assert.equal(crm.status, 201);
      assert.equal(crm.body.id, "crm-prod");
      assert.equal("storeId" in crm.body || "store_id" in crm.body, false);

      const resolver = createResolver(lookup, apiUrl as string);
      const a = await resolver.resolve("crm-prod");
      const b = await resolver.resolve(hr.body.id);
      assert.notEqual(a.storeId, b.storeId);
      assert.notEqual(a.modelId, b.modelId);

      const { rows } = await pool.query(
        "SELECT count(*)::int AS n FROM model_bindings WHERE active",
      );
      assert.equal(rows[0].n, 2);
      const audit = await pool.query(
        "SELECT count(*)::int AS n FROM audit_events WHERE action = 'applications.create'",
      );
      assert.equal(audit.rows[0].n, 2);
    }),
);

test(
  "an unknown application is 404, and so is one outside the caller's allow-list",
  opts,
  () =>
    withApp(async (call) => {
      await call("admin", "POST", "/v1/applications", {
        name: "crm",
        environment: "prod",
      });
      await call("admin", "POST", "/v1/applications", {
        name: "hr",
        environment: "prod",
      });

      assert.equal(
        (await call("admin", "GET", "/v1/applications/nope-prod")).status,
        404,
      );
      assert.equal(
        (await call("crmOnly", "GET", "/v1/applications/crm-prod")).status,
        200,
      );
      assert.equal(
        (await call("crmOnly", "GET", "/v1/applications/hr-prod")).status,
        404,
      );
      assert.equal(
        (await call("crmOnly", "GET", "/v1/models?application=hr-prod")).status,
        404,
      );

      const list = await call("crmOnly", "GET", "/v1/applications");
      assert.deepEqual(
        list.body.items.map((a: { id: string }) => a.id),
        ["crm-prod"],
      );
    }),
);

test("lists the active model for an application", opts, () =>
  withApp(async (call) => {
    await call("admin", "POST", "/v1/applications", {
      name: "crm",
      environment: "prod",
    });
    const res = await call("admin", "GET", "/v1/models?application=crm-prod");
    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0]?.active, true);
  }),
);

test("rejects bad registrations", opts, () =>
  withApp(async (call) => {
    const ok = { name: "crm", environment: "prod" };
    assert.equal(
      (await call("noScope", "POST", "/v1/applications", ok)).status,
      403,
    );
    // Request bodies must not accept store or model IDs.
    assert.equal(
      (await call("admin", "POST", "/v1/applications", { ...ok, storeId: "x" }))
        .status,
      400,
    );
    assert.equal(
      (
        await call("admin", "POST", "/v1/applications", {
          name: "crm",
          environment: "a-b",
        })
      ).status,
      400,
    );
    assert.equal(
      (await call("admin", "POST", "/v1/applications", ok)).status,
      201,
    );
    assert.equal(
      (await call("admin", "POST", "/v1/applications", ok)).status,
      409,
    );
  }),
);
