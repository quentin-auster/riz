import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { Riz, RizAuthError } from "../src/index.js";

// Runs the SDK against the compose stack (`make up`, then `make integration`).
// OpenFGA is called directly only to seed a tuple, since the relationships API
// is a later milestone. Tokens are the dev-only values in deploy/fixtures.
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
const api = required("RIZ_API_URL");
const openfga = required("OPENFGA_API_URL");

async function json(res: Response): Promise<Record<string, unknown>> {
  assert.ok(res.ok, `${res.url} answered ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/** Registers an application in which alice, and only alice, can read document:d1. */
async function applicationWithAlice(): Promise<string> {
  const admin = { authorization: "Bearer dev-admin-token" };
  const app = (await json(
    await fetch(`${api}/v1/applications`, {
      method: "POST",
      headers: { ...admin, "content-type": "application/json" },
      body: JSON.stringify({
        name: `sdk${randomBytes(6).toString("hex")}`,
        environment: "prod",
      }),
    }),
  )) as { id: string };

  const models = (await json(
    await fetch(`${api}/v1/models?application=${app.id}`, { headers: admin }),
  )) as { items: { id: string; active: boolean }[] };
  const model = models.items.find((m) => m.active);
  // The store is named after the application ID; the riz API never exposes store IDs.
  const stores = (await json(
    await fetch(`${openfga}/stores?name=${app.id}`),
  )) as { stores: { id: string }[] };
  assert.ok(model && stores.stores.length === 1);

  await json(
    await fetch(`${openfga}/stores/${stores.stores[0]?.id}/write`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        authorization_model_id: model.id,
        writes: {
          tuple_keys: [
            {
              user: "project:p1",
              relation: "project",
              object: "document:d1",
            },
            { user: "user:alice", relation: "viewer", object: "project:p1" },
          ],
        },
      }),
    }),
  );
  return app.id;
}

const client = (application: string) =>
  new Riz({ baseUrl: api, credentials: "dev-check-token", application });

test("check and batchCheck decide per the application's relationships", async () => {
  const riz = client(await applicationWithAlice());
  const endUserToken = "dev-alice-token";

  const read = await riz.check({
    action: "read",
    resource: "document:d1",
    endUserToken,
  });
  assert.equal(read.allowed, true);
  assert.ok(read.modelId);

  const other = await riz.check({
    action: "read",
    resource: "document:d2",
    endUserToken,
  });
  assert.equal(other.allowed, false);

  const batch = await riz.batchCheck(
    [
      { action: "read", resource: "document:d1" },
      { action: "read", resource: "document:d2" },
    ],
    { endUserToken },
  );
  assert.deepEqual(
    batch.results.map((r) => r.status),
    ["allow", "deny"],
  );
});

test("check raises an auth error for an end-user token riz does not accept", async () => {
  const riz = client(await applicationWithAlice());
  await assert.rejects(
    riz.check({
      action: "read",
      resource: "document:d1",
      endUserToken: "not-a-known-token",
    }),
    (err: unknown) =>
      err instanceof RizAuthError &&
      err.status === 401 &&
      err.code === "invalid_end_user_token",
  );
});
