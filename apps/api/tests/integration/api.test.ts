import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { OpenFgaClient } from "@openfga/sdk";
import { transformer } from "@openfga/syntax-transformer";

// Black-box suite against the running compose stack (`make integration`):
// the riz API over HTTP, and OpenFGA directly only to seed tuples and models,
// since the relationships API is a later milestone. Fixture tokens are the
// dev-only values in deploy/fixtures.
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
const api = required("RIZ_API_URL");
const openfga = required("OPENFGA_API_URL");

const ADMIN = "dev-admin-token";
const CHECK = "dev-check-token";
const ALICE = "dev-alice-token";

type Json = Record<string, unknown>;

async function call(
  method: string,
  path: string,
  opts: { token?: string; user?: string; body?: unknown } = {},
): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.user ? { "riz-end-user-token": opts.user } : {}),
      "content-type": "application/json",
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  return { status: res.status, body: (await res.json()) as Json };
}

/** Registers a uniquely named application, since the stack's database persists between runs. */
async function register(): Promise<string> {
  const name = `it${randomBytes(6).toString("hex")}`;
  const res = await call("POST", "/v1/applications", {
    token: ADMIN,
    body: { name, environment: "prod" },
  });
  assert.equal(res.status, 201);
  return res.body.id as string;
}

async function activeModel(app: string): Promise<string> {
  const { body } = await call("GET", `/v1/models?application=${app}`, {
    token: ADMIN,
  });
  const active = (body.items as { id: string; active: boolean }[]).filter(
    (m) => m.active,
  );
  assert.equal(active.length, 1);
  return (active[0] as { id: string }).id;
}

async function storeClient(app: string, authorizationModelId?: string) {
  // The store is named after the application ID; the riz API never exposes store IDs.
  const res = await fetch(`${openfga}/stores?name=${app}`);
  const { stores } = (await res.json()) as { stores: { id: string }[] };
  assert.equal(stores.length, 1, `one store named ${app}`);
  return new OpenFgaClient({
    apiUrl: openfga,
    storeId: (stores[0] as { id: string }).id,
    ...(authorizationModelId ? { authorizationModelId } : {}),
  });
}

/** Makes alice a viewer, so she can read document:d1. */
async function grantAlice(app: string) {
  const client = await storeClient(app, await activeModel(app));
  await client.write({
    writes: [
      { user: "project:p1", relation: "project", object: "document:d1" },
      { user: "user:alice", relation: "viewer", object: "project:p1" },
    ],
  });
}

const read = (application: string, object = "document:d1") => ({
  application,
  relation: "read",
  object,
});

test("liveness and readiness are open and healthy", async () => {
  assert.equal((await call("GET", "/health/live")).status, 200);
  assert.equal((await call("GET", "/health/ready")).status, 200);
});

test("registers an application and rejects bad, duplicate and unauthorized registrations", async () => {
  const app = await register();
  const name = app.replace(/-prod$/, "");

  const got = await call("GET", `/v1/applications/${app}`, { token: ADMIN });
  assert.equal(got.status, 200);
  assert.equal("storeId" in got.body || "store_id" in got.body, false);
  const list = await call("GET", "/v1/applications?limit=100", {
    token: ADMIN,
  });
  assert.equal(list.status, 200);
  await activeModel(app);

  const post = (body: unknown, token = ADMIN) =>
    call("POST", "/v1/applications", { token, body });
  assert.equal((await post({ name, environment: "prod" })).status, 409);
  assert.equal(
    (await post({ name: "x", environment: "prod", storeId: "s" })).status,
    400,
  );
  assert.equal((await post({ name: "x", environment: "a-b" })).status, 400);
  assert.equal(
    (await post({ name: "x", environment: "prod" }, CHECK)).status,
    403,
  );
  assert.equal(
    (await call("POST", "/v1/applications", { body: {} })).status,
    401,
  );
});

test("unknown applications are 404 on every application-scoped read", async () => {
  assert.equal(
    (await call("GET", "/v1/applications/nope-prod", { token: ADMIN })).status,
    404,
  );
  assert.equal(
    (await call("GET", "/v1/models?application=nope-prod", { token: ADMIN }))
      .status,
    404,
  );
  assert.equal(
    (
      await call("POST", "/v1/check", {
        token: CHECK,
        user: ALICE,
        body: read("nope-prod"),
      })
    ).status,
    404,
  );
});

test("check allows the granted relation, denies others, and rejects unverified callers", async () => {
  const app = await register();
  await grantAlice(app);
  const model = await activeModel(app);

  const allow = await call("POST", "/v1/check", {
    token: CHECK,
    user: ALICE,
    body: read(app),
  });
  assert.equal(allow.body.status, "allow");
  assert.equal(allow.body.modelId, model);

  const deny = await call("POST", "/v1/check", {
    token: CHECK,
    user: ALICE,
    body: { ...read(app), relation: "delete" },
  });
  assert.equal(deny.body.status, "deny");

  const check = (opts: { token?: string; user?: string }) =>
    call("POST", "/v1/check", { ...opts, body: read(app) });
  assert.equal((await check({ token: CHECK })).status, 401);
  assert.equal((await check({ token: CHECK, user: "forged" })).status, 401);
  assert.equal((await check({ user: ALICE })).status, 401);
  assert.equal((await check({ token: "bad", user: ALICE })).status, 401);
});

test("batch results equal individual checks, and bad batches are rejected", async () => {
  const app = await register();
  await grantAlice(app);

  const grid = ["read", "edit", "delete", "share"].flatMap((rel) =>
    ["document:d1", "document:other"].map((obj) => [rel, obj] as const),
  );
  const batch = await call("POST", "/v1/batch-check", {
    token: CHECK,
    user: ALICE,
    body: {
      application: app,
      checks: grid.map(([relation, object], i) => ({
        correlationId: `c${i}`,
        relation,
        object,
      })),
    },
  });
  assert.equal(batch.status, 200);
  const results = batch.body.results as {
    correlationId: string;
    status: string;
  }[];
  const statuses = new Set<string>();
  for (const [i, [relation, object]] of grid.entries()) {
    const single = await call("POST", "/v1/check", {
      token: CHECK,
      user: ALICE,
      body: { application: app, relation, object },
    });
    assert.equal(results[i]?.correlationId, `c${i}`);
    assert.equal(
      results[i]?.status,
      single.body.status,
      `${relation} ${object}`,
    );
    statuses.add(single.body.status as string);
  }
  assert.deepEqual([...statuses].sort(), ["allow", "deny"]);

  const item = (correlationId: string) => ({
    correlationId,
    relation: "read",
    object: "document:d1",
  });
  const post = (checks: unknown[]) =>
    call("POST", "/v1/batch-check", {
      token: CHECK,
      user: ALICE,
      body: { application: app, checks },
    });
  const tooBig = await post(
    Array.from({ length: 101 }, (_, i) => item(`c${i}`)),
  );
  assert.equal(tooBig.body.code, "batch_too_large");
  assert.equal(
    (await post([item("a"), item("a")])).body.code,
    "duplicate_correlation_id",
  );
  assert.equal((await post([])).status, 400);
});

test("one application's tuples are invisible to another", async () => {
  const a = await register();
  const b = await register();
  await grantAlice(a);

  const decide = async (app: string) =>
    (
      await call("POST", "/v1/check", {
        token: CHECK,
        user: ALICE,
        body: read(app),
      })
    ).body.status;
  assert.equal(await decide(a), "allow");
  assert.equal(await decide(b), "deny");
});

test("decisions stay on the pinned model after a newer model is written to the store", async () => {
  const app = await register();
  await grantAlice(app);
  const pinned = await activeModel(app);

  // A newer model under which alice's tuples would no longer grant read.
  const client = await storeClient(app);
  const { authorization_model_id: newer } =
    await client.writeAuthorizationModel(
      transformer.transformDSLToJSONObject(
        "model\n  schema 1.1\ntype user\ntype document\n  relations\n    define read: [user]\n",
      ),
    );
  assert.notEqual(newer, pinned);

  const res = await call("POST", "/v1/check", {
    token: CHECK,
    user: ALICE,
    body: read(app),
  });
  assert.equal(res.body.status, "allow");
  assert.equal(res.body.modelId, pinned);
  assert.equal(await activeModel(app), pinned);
});
