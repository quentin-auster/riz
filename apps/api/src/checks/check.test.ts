import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { ConsistencyPreference, OpenFgaClient } from "@openfga/sdk";
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
const endUsers: Record<string, string> = {
  "alice-token": "alice",
  "bob-token": "bob",
  "userset-token": "alice#member",
};
const MAX_BATCH = 10;

type Res = { status: number; body: Record<string, unknown> };
type Call = (
  token: string,
  body: unknown,
  endUserToken?: string,
  path?: string,
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
    /** Removes alice's read access to document:d1. */
    revokeAlice: () => Promise<void>;
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
      maxBatchSize: MAX_BATCH,
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
      readiness: async () => [],
      log: () => {},
      authenticate: (h) => principals[h?.replace("Bearer ", "") ?? ""] ?? null,
      routes: async (req, res, p, u) =>
        (await admin(req, res, p, u)) || check(req, res, p, u),
    });
    servers.push(server);
    const port = await listen(server);
    return async (token, body, endUserToken, path = "/v1/check") => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
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
    const fga = new OpenFgaClient({
      apiUrl: apiUrl as string,
      storeId: binding.storeId,
      authorizationModelId: binding.modelId,
    });
    await fga.write({
      writes: [
        { user: "project:p1", relation: "project", object: "document:d1" },
        { user: "user:alice", relation: "viewer", object: "project:p1" },
      ],
    });

    await fn({
      admin,
      callWith: serve,
      revokeAlice: async () => {
        await fga.write({
          deletes: [
            { user: "user:alice", relation: "viewer", object: "project:p1" },
          ],
        });
      },
    });
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
      // A subject that would form an OpenFGA userset is refused, not passed through.
      assert.equal((await admin("admin", read, "userset-token")).status, 401);
    }),
);

test(
  "a workload not bound to the application gets 403, whether or not it exists",
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
        403,
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

const BATCH = "/v1/batch-check";
const item = (correlationId: string, relation: string, object: string) => ({
  correlationId,
  relation,
  object,
});

/** A fake OpenFGA whose batch-check answers come from `answer`, keyed by correlation ID. */
async function stubBatchUpstream(
  answer: (ids: string[]) => Record<string, unknown>,
) {
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const ids = (
      JSON.parse(raw) as { checks: { correlation_id: string }[] }
    ).checks.map((c) => c.correlation_id);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ result: answer(ids) }));
  });
  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

test(
  "batch results equal the individual check results for the same inputs",
  opts,
  () =>
    withApp(async ({ admin }) => {
      const grid = ["read", "edit", "delete", "share"].flatMap((rel) =>
        ["document:d1", "document:other"].map((obj) => [rel, obj] as const),
      );
      grid.push(["viewer", "project:p1"], ["editor", "project:p1"]);
      for (const token of ["alice-token", "bob-token"]) {
        const checks = grid.map(([rel, obj], i) => item(`c${i}`, rel, obj));
        const batch = await admin(
          "admin",
          { application: "crm-prod", checks },
          token,
          BATCH,
        );
        assert.equal(batch.status, 200);
        const results = batch.body.results as {
          correlationId: string;
          status: string;
        }[];
        assert.equal(results.length, grid.length);
        for (const [i, [rel, obj]] of grid.entries()) {
          const single = await admin(
            "admin",
            { application: "crm-prod", relation: rel, object: obj },
            token,
          );
          assert.equal(results[i]?.correlationId, `c${i}`);
          assert.equal(
            results[i]?.status,
            single.body.status,
            `${token} ${rel} ${obj}`,
          );
        }
      }
      // The grid must contain both outcomes, or equality proves little.
      const alice = await admin(
        "admin",
        { application: "crm-prod", checks: [item("x", "read", "document:d1")] },
        "alice-token",
        BATCH,
      );
      assert.deepEqual(alice.body.results, [
        { correlationId: "x", status: "allow" },
      ]);
    }),
);

/** A fake OpenFGA that allows everything and records the `consistency` it was sent. */
async function stubRecordingConsistency() {
  const seen: unknown[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw) as {
      consistency?: unknown;
      checks?: { correlation_id: string }[];
    };
    seen.push(body.consistency);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        body.checks
          ? {
              result: Object.fromEntries(
                body.checks.map((c) => [c.correlation_id, { allowed: true }]),
              ),
            }
          : { allowed: true },
      ),
    );
  });
  const port = await listen(server);
  return {
    seen,
    url: `http://127.0.0.1:${port}`,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

test(
  "passes the requested consistency to OpenFGA for check and batch, and none by default",
  opts,
  () =>
    withApp(async ({ callWith }) => {
      const upstream = await stubRecordingConsistency();
      try {
        const call = await callWith(upstream.url, 2000);
        const batch = [item("a", "read", "document:d1")];
        for (const consistency of [
          undefined,
          "minimize_latency",
          "higher_consistency",
        ]) {
          const extra = consistency === undefined ? {} : { consistency };
          assert.equal(
            (await call("admin", { ...read, ...extra }, "alice-token")).status,
            200,
          );
          assert.equal(
            (
              await call(
                "admin",
                { application: "crm-prod", checks: batch, ...extra },
                "alice-token",
                BATCH,
              )
            ).status,
            200,
          );
        }
        assert.deepEqual(upstream.seen, [
          undefined,
          undefined,
          ConsistencyPreference.MinimizeLatency,
          ConsistencyPreference.MinimizeLatency,
          ConsistencyPreference.HigherConsistency,
          ConsistencyPreference.HigherConsistency,
        ]);
      } finally {
        upstream.close();
      }
    }),
);

test(
  "higher_consistency denies a user whose access was just revoked",
  opts,
  () =>
    withApp(async ({ admin, revokeAlice }) => {
      const batch = {
        application: "crm-prod",
        checks: [item("x", "read", "document:d1")],
        consistency: "higher_consistency",
      };
      assert.equal(
        (
          await admin(
            "admin",
            { ...read, consistency: "higher_consistency" },
            "alice-token",
          )
        ).body.status,
        "allow",
      );

      await revokeAlice();

      const single = await admin(
        "admin",
        { ...read, consistency: "higher_consistency" },
        "alice-token",
      );
      assert.equal(single.body.status, "deny");
      const many = await admin("admin", batch, "alice-token", BATCH);
      assert.deepEqual(many.body.results, [
        { correlationId: "x", status: "deny" },
      ]);
    }),
);

test("an unknown consistency value is a 400 for check and batch", opts, () =>
  withApp(async ({ admin }) => {
    for (const consistency of ["eventual", "", 1, null]) {
      const single = await admin(
        "admin",
        { ...read, consistency },
        "alice-token",
      );
      assert.equal(single.status, 400, JSON.stringify(consistency));
      assert.equal(single.body.code, "invalid_request");
      const many = await admin(
        "admin",
        {
          application: "crm-prod",
          checks: [item("x", "read", "document:d1")],
          consistency,
        },
        "alice-token",
        BATCH,
      );
      assert.equal(many.status, 400, JSON.stringify(consistency));
    }
  }),
);

test(
  "maps batch answers by correlation ID even when upstream order is shuffled",
  opts,
  () =>
    withApp(async ({ callWith }) => {
      // Upstream answers in reverse order; the answer is encoded in the ID.
      const upstream = await stubBatchUpstream((ids) =>
        Object.fromEntries(
          [...ids]
            .reverse()
            .map((id) => [id, { allowed: id.includes("allow") }]),
        ),
      );
      try {
        const call = await callWith(upstream.url, 2000);
        const res = await call(
          "admin",
          {
            application: "crm-prod",
            checks: ["a-deny", "b-allow", "c-deny", "d-allow"].map((id) =>
              item(id, "read", "document:d1"),
            ),
          },
          "alice-token",
          BATCH,
        );
        assert.deepEqual(res.body.results, [
          { correlationId: "a-deny", status: "deny" },
          { correlationId: "b-allow", status: "allow" },
          { correlationId: "c-deny", status: "deny" },
          { correlationId: "d-allow", status: "allow" },
        ]);
      } finally {
        upstream.close();
      }
    }),
);

test(
  "a failed or missing batch item is indeterminate without affecting the others",
  opts,
  () =>
    withApp(async ({ callWith }) => {
      const upstream = await stubBatchUpstream((ids) => ({
        [ids[0] as string]: { allowed: true },
        [ids[1] as string]: {
          error: { internal_error: "internal_error", message: "x" },
        },
        // ids[2] is never answered.
      }));
      try {
        const call = await callWith(upstream.url, 2000);
        const res = await call(
          "admin",
          {
            application: "crm-prod",
            checks: ["a", "b", "c"].map((id) =>
              item(id, "read", "document:d1"),
            ),
          },
          "alice-token",
          BATCH,
        );
        assert.deepEqual(res.body.results, [
          { correlationId: "a", status: "allow" },
          { correlationId: "b", status: "indeterminate" },
          { correlationId: "c", status: "indeterminate" },
        ]);
      } finally {
        upstream.close();
      }
    }),
);

test(
  "a batch is all indeterminate, never allow, when OpenFGA is unreachable",
  opts,
  () =>
    withApp(async ({ callWith }) => {
      const call = await callWith("http://127.0.0.1:1", 2000);
      const res = await call(
        "admin",
        {
          application: "crm-prod",
          checks: [
            item("a", "read", "document:d1"),
            item("b", "edit", "document:d1"),
          ],
        },
        "alice-token",
        BATCH,
      );
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.results, [
        { correlationId: "a", status: "indeterminate" },
        { correlationId: "b", status: "indeterminate" },
      ]);
      assert.equal("modelId" in res.body, false);
    }),
);

test(
  "rejects an over-limit batch, duplicate correlation IDs and a foreign application",
  opts,
  () =>
    withApp(async ({ admin }) => {
      const many = Array.from({ length: MAX_BATCH + 1 }, (_, i) =>
        item(`c${i}`, "read", "document:d1"),
      );
      const tooBig = await admin(
        "admin",
        { application: "crm-prod", checks: many },
        "alice-token",
        BATCH,
      );
      assert.equal(tooBig.status, 400);
      assert.equal(tooBig.body.code, "batch_too_large");

      const dup = await admin(
        "admin",
        {
          application: "crm-prod",
          checks: [
            item("a", "read", "document:d1"),
            item("a", "edit", "document:d1"),
          ],
        },
        "alice-token",
        BATCH,
      );
      assert.equal(dup.status, 400);
      assert.equal(dup.body.code, "duplicate_correlation_id");

      const one = { checks: [item("a", "read", "document:d1")] };
      assert.equal(
        (
          await admin(
            "crmOnly",
            { application: "hr-prod", ...one },
            "alice-token",
            BATCH,
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await admin(
            "noScope",
            { application: "crm-prod", ...one },
            "alice-token",
            BATCH,
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await admin(
            "admin",
            { application: "crm-prod", ...one },
            undefined,
            BATCH,
          )
        ).status,
        401,
      );
    }),
);
