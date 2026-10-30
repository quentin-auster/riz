import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { OpenFgaClient } from "@openfga/sdk";
import { transformer } from "@openfga/syntax-transformer";
import pg from "pg";
import { adminRoutes } from "../admin/routes.js";
import { createAdminService } from "../admin/service.js";
import type { Principal } from "../auth/index.js";
import { migrate } from "../db/migrate.js";
import { createApp } from "../server.js";
import { createResolver, dbLookup } from "./resolver.js";
import { checkRoutes } from "./routes.js";
import { createCheckService } from "./service.js";

// Integration: needs Postgres and OpenFGA. Unverified until run against both.
const url = process.env.RIZ_DATABASE_URL;
const apiUrl = process.env.OPENFGA_API_URL;
const opts = {
  skip: url && apiUrl ? false : "RIZ_DATABASE_URL and OPENFGA_API_URL not set",
};

const principals: Record<string, Principal> = {
  admin: {
    subject: "admin",
    scopes: ["applications:write", "check"],
    applications: ["*"],
  },
  crmOnly: { subject: "crm", scopes: ["check"], applications: ["crm-prod"] },
  noScope: { subject: "ns", scopes: [], applications: ["*"] },
};
const endUsers: Record<string, string> = { "alice-token": "alice" };

type Res = { status: number; body: Record<string, unknown> };
type Call = (
  token: string,
  body: unknown,
  endUserToken?: string,
) => Promise<Res>;

function listen(server: Server) {
  return new Promise<number>((resolve) =>
    server.listen(0, () => resolve((server.address() as AddressInfo).port)),
  );
}

/** Registers crm-prod and grants alice (only) read on document:d1. */
async function withApp(
  fn: (ctx: {
    admin: Call;
    callWith: (openfgaUrl: string, timeoutMs: number) => Promise<Call>;
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
  const servers: Server[] = [];

  // One API over the real OpenFGA; `callWith` builds another whose checks use a different OpenFGA URL.
  async function serve(openfgaUrl: string, timeoutMs: number): Promise<Call> {
    const check = checkRoutes({
      service: createCheckService({
        resolver: createResolver(dbLookup(pool), openfgaUrl),
        timeoutMs,
      }),
      verifyEndUser: (t) => (t && endUsers[t]) || null,
    });
    const admin = adminRoutes(
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
    );
    const server = createApp({
      authenticate: (h) => principals[h?.replace("Bearer ", "") ?? ""] ?? null,
      routes: async (req, res, p, u) =>
        (await admin(req, res, p, u)) || check(req, res, p, u),
    });
    servers.push(server);
    const port = await listen(server);
    return async (token, body, endUserToken) => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/check`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...(endUserToken ? { "riz-end-user-token": endUserToken } : {}),
        },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    };
  }

  try {
    const c = await pool.connect();
    await migrate(c);
    c.release();
    const admin = await serve(apiUrl as string, 2000);

    const registered = await fetch(
      `http://127.0.0.1:${(servers[0]?.address() as AddressInfo).port}/v1/applications`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer admin",
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "crm", environment: "prod" }),
      },
    );
    assert.equal(registered.status, 201);
    const binding = await createResolver(
      dbLookup(pool),
      apiUrl as string,
    ).resolve("crm-prod");
    await new OpenFgaClient({
      apiUrl: apiUrl as string,
      storeId: binding.storeId,
      authorizationModelId: binding.modelId,
    }).write({
      writes: [
        { user: "project:p1", relation: "project", object: "document:d1" },
        { user: "user:alice", relation: "viewer", object: "project:p1" },
      ],
    });

    await fn({ admin, callWith: serve });
  } finally {
    for (const s of servers) s.close();
    await pool.end();
    await setup.query(`DROP SCHEMA ${schema} CASCADE`);
    await setup.end();
  }
}

const read = {
  application: "crm-prod",
  relation: "read",
  object: "document:d1",
};

test(
  "allows the end user who holds the relation and denies one who does not",
  opts,
  () =>
    withApp(async ({ admin }) => {
      const allow = await admin("admin", read, "alice-token");
      assert.equal(allow.status, 200);
      assert.equal(allow.body.status, "allow");
      assert.match(String(allow.body.modelId), /^[0-9A-Z]{26}$/);
      assert.match(String(allow.body.requestId), /^req_/);

      const deny = await admin(
        "admin",
        { ...read, object: "document:other" },
        "alice-token",
      );
      assert.equal(deny.status, 200);
      assert.equal(deny.body.status, "deny");
    }),
);

test("rejects a request that tries to name the user in the body", opts, () =>
  withApp(async ({ admin }) => {
    const res = await admin(
      "admin",
      { ...read, user: "user:alice" },
      "alice-token",
    );
    assert.equal(res.status, 400);
  }),
);

test(
  "rejects missing or unverifiable end-user tokens and workloads without the check scope",
  opts,
  () =>
    withApp(async ({ admin }) => {
      assert.equal((await admin("admin", read)).status, 401);
      const bad = await admin("admin", read, "nope");
      assert.equal(bad.status, 401);
      assert.equal(bad.body.code, "invalid_end_user_token");
      assert.equal((await admin("noScope", read, "alice-token")).status, 403);
    }),
);

test(
  "a workload not allow-listed for the application gets 404, same as an unknown one",
  opts,
  () =>
    withApp(async ({ admin }) => {
      assert.equal(
        (
          await admin(
            "crmOnly",
            { ...read, application: "hr-prod" },
            "alice-token",
          )
        ).status,
        404,
      );
      assert.equal(
        (
          await admin(
            "admin",
            { ...read, application: "hr-prod" },
            "alice-token",
          )
        ).status,
        404,
      );
      assert.equal((await admin("crmOnly", read, "alice-token")).status, 200);
    }),
);

test("is indeterminate, never allow, when OpenFGA is unreachable", opts, () =>
  withApp(async ({ callWith }) => {
    const call = await callWith("http://127.0.0.1:1", 2000);
    const res = await call("admin", read, "alice-token");
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "indeterminate");
    assert.equal(res.body.code, "backend_error");
    assert.equal("modelId" in res.body, false);
  }),
);

test("is indeterminate within the timeout when OpenFGA hangs", opts, () =>
  withApp(async ({ callWith }) => {
    const hang = createServer(() => {});
    const port = await listen(hang);
    try {
      const call = await callWith(`http://127.0.0.1:${port}`, 300);
      const started = Date.now();
      const res = await call("admin", read, "alice-token");
      assert.equal(res.body.status, "indeterminate");
      assert.equal(res.body.code, "timeout");
      assert.ok(Date.now() - started < 1500, "answered well past the timeout");
    } finally {
      hang.closeAllConnections();
      hang.close();
    }
  }),
);
