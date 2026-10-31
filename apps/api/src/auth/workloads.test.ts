import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import pg from "pg";
import { ApplicationNotFound } from "../checks/resolver.js";
import { migrate } from "../db/migrate.js";
import { createApp } from "../server.js";
import type { TokenVerifier } from "./oidc.js";
import type { Principal } from "./principal.js";
import { workloadRoutes } from "./workloadRoutes.js";
import {
  type BindingStore,
  createBindingStore,
  type WorkloadBinding,
  workloadAuthenticator,
} from "./workloads.js";

const ISSUER = "https://idp.example.test";

const verifier =
  (claims: Record<string, unknown>): TokenVerifier =>
  async (token) =>
    token === "good" ? { issuer: ISSUER, subject: "sub-1", claims } : null;

test("a verified workload gets the check scope and only its bound applications", async () => {
  const seen: string[][] = [];
  const authenticate = workloadAuthenticator(
    verifier({ azp: "crm-service" }),
    async (issuer, workload) => {
      seen.push([issuer, workload]);
      return ["crm-prod"];
    },
  );
  const principal = await authenticate("Bearer good");
  assert.deepEqual(principal, {
    subject: `${ISSUER}|crm-service`,
    scopes: ["check"],
    applications: ["crm-prod"],
    clientId: "crm-service",
  });
  assert.deepEqual(seen, [[ISSUER, "crm-service"]]);
});

test("a workload is identified by azp, else client_id, else sub", async () => {
  const workloadOf = async (claims: Record<string, unknown>) => {
    let workload = "";
    await workloadAuthenticator(verifier(claims), async (_, w) => {
      workload = w;
      return [];
    })("Bearer good");
    return workload;
  };
  assert.equal(await workloadOf({ azp: "a", client_id: "c" }), "a");
  assert.equal(await workloadOf({ client_id: "c" }), "c");
  assert.equal(await workloadOf({}), "sub-1");
});

test("an unbound workload is authenticated but reaches no application", async () => {
  const principal = await workloadAuthenticator(verifier({}), async () => [])(
    "Bearer good",
  );
  assert.deepEqual(principal?.applications, []);
});

test("an invalid token or malformed header is not authenticated, and never reaches the lookup", async () => {
  const authenticate = workloadAuthenticator(verifier({}), async () => {
    throw new Error("lookup must not run");
  });
  assert.equal(await authenticate("Bearer bad"), null);
  assert.equal(await authenticate("Basic good"), null);
  assert.equal(await authenticate(undefined), null);
});

// workloadRoutes, with a recording store in place of Postgres.
const principals: Record<string, Principal> = {
  admin: {
    subject: "admin",
    scopes: ["bindings:write"],
    applications: ["*"],
  },
  appAdmin: {
    subject: "app-admin",
    scopes: ["bindings:write"],
    applications: ["crm-prod"],
  },
  noScope: { subject: "ns", scopes: ["check"], applications: ["*"] },
};

async function withRoutes(
  fn: (
    call: (
      who: string,
      method: string,
      path: string,
      body?: unknown,
    ) => Promise<number>,
    calls: string[],
  ) => Promise<void>,
) {
  const calls: string[] = [];
  const store = {
    bind: async (actor: string, b: WorkloadBinding) => {
      calls.push(`bind ${actor} ${b.application}`);
    },
    unbind: async (actor: string, b: WorkloadBinding) => {
      calls.push(`unbind ${actor} ${b.application}`);
    },
  } as unknown as BindingStore;
  const server = createApp({
    readiness: async () => [],
    log: () => {},
    authenticate: (h) => principals[h?.replace("Bearer ", "") ?? ""] ?? null,
    routes: workloadRoutes(store),
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(async (who, method, path, body) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${who}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return res.status;
    }, calls);
  } finally {
    server.close();
  }
}

const binding = { issuer: ISSUER, workload: "w", application: "crm-prod" };
const DELETE_PATH = `/v1/workload-bindings?issuer=${encodeURIComponent(ISSUER)}&workload=w&application=crm-prod`;

test("only a platform administrator with bindings:write can change bindings", () =>
  withRoutes(async (call, calls) => {
    const path = "/v1/workload-bindings";
    // Not even an administrator of that very application may widen who reaches it.
    assert.equal(await call("appAdmin", "POST", path, binding), 403);
    assert.equal(await call("noScope", "POST", path, binding), 403);
    assert.equal(await call("appAdmin", "DELETE", DELETE_PATH), 403);
    assert.equal(await call("noScope", "DELETE", DELETE_PATH), 403);
    assert.deepEqual(calls, []);

    assert.equal(await call("admin", "POST", path, binding), 201);
    assert.equal(await call("admin", "DELETE", DELETE_PATH), 204);
    assert.deepEqual(calls, ["bind admin crm-prod", "unbind admin crm-prod"]);
  }));

test("a malformed binding is rejected before it reaches the store", () =>
  withRoutes(async (call, calls) => {
    const path = "/v1/workload-bindings";
    assert.equal(
      await call("admin", "POST", path, { ...binding, application: "Bad ID" }),
      400,
    );
    assert.equal(
      await call("admin", "POST", path, { ...binding, extra: 1 }),
      400,
    );
    assert.equal(await call("admin", "POST", path, { issuer: ISSUER }), 400);
    assert.equal(await call("admin", "DELETE", path), 400);
    assert.deepEqual(calls, []);
  }));

// Store, against Postgres. Unverified until run against it.
const url = process.env.RIZ_DATABASE_URL;
const opts = { skip: url ? false : "RIZ_DATABASE_URL not set" };

async function withStore(
  fn: (store: BindingStore, pool: pg.Pool) => Promise<void>,
) {
  const schema = `t_${randomUUID().replaceAll("-", "")}`;
  const setup = new pg.Client({ connectionString: url });
  await setup.connect();
  await setup.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({
    connectionString: url,
    options: `-c search_path=${schema}`,
  });
  try {
    const c = await pool.connect();
    await migrate(c);
    await c.query(
      "INSERT INTO applications (id, name, environment, store_id) VALUES ('crm-prod', 'crm', 'prod', 'store-1')",
    );
    c.release();
    await fn(createBindingStore(pool), pool);
  } finally {
    await pool.end();
    await setup.query(`DROP SCHEMA ${schema} CASCADE`);
    await setup.end();
  }
}

test("a binding is looked up, audited once, and removed", opts, () =>
  withStore(async (store, pool) => {
    assert.deepEqual(await store.lookup(ISSUER, "w"), []);

    await store.bind("admin", binding);
    await store.bind("admin", binding);
    assert.deepEqual(await store.lookup(ISSUER, "w"), ["crm-prod"]);
    // Bound to one workload, not another, and not under another issuer.
    assert.deepEqual(await store.lookup(ISSUER, "other"), []);
    assert.deepEqual(await store.lookup("https://other.example", "w"), []);

    await store.unbind("admin", binding);
    await store.unbind("admin", binding);
    assert.deepEqual(await store.lookup(ISSUER, "w"), []);

    const { rows } = await pool.query(
      "SELECT actor, action, application_id FROM audit_events ORDER BY id",
    );
    assert.deepEqual(
      rows.map((r) => `${r.actor} ${r.action} ${r.application_id}`),
      ["admin workloads.bind crm-prod", "admin workloads.unbind crm-prod"],
    );
  }),
);

test(
  "binding to an application that does not exist is refused and not audited",
  opts,
  () =>
    withStore(async (store, pool) => {
      await assert.rejects(
        store.bind("admin", { ...binding, application: "hr-prod" }),
        ApplicationNotFound,
      );
      const { rowCount } = await pool.query("SELECT 1 FROM audit_events");
      assert.equal(rowCount, 0);
    }),
);
