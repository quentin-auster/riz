import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  type Call,
  client,
  fixtureFiles,
  type RunningApi,
  readDoc,
  required,
  startApi,
  unique,
} from "./harness.js";

// Model migration safety (RIZ-042): model changes are validated, versioned, reversible and
// isolated per application. Needs RIZ_DATABASE_URL and OPENFGA_API_URL.
const openfga = required("OPENFGA_API_URL");
const PLATFORM = "tok-platform";
const CHECK = "tok-check";
const BOB = "tok-user-bob";
const ANNE = "tok-user-anne";

const base = readFileSync(
  join(import.meta.dirname, "../../models/openfga/base.fga"),
  "utf8",
);
// Same as base except a team no longer grants its members view access to a project.
const tight = base.replace(
  "define viewer: [user] or editor or member from team",
  "define viewer: [user] or editor",
);
assert.notEqual(tight, base);

const tuples = [
  { subject: "project:p1", relation: "project", object: "document:d1" },
  { subject: "user:anne", relation: "viewer", object: "project:p1" },
  { subject: "team:eng", relation: "team", object: "project:p1" },
  { subject: "user:bob", relation: "member", object: "team:eng" },
];
const reads = (user: string, allowed: boolean) => ({
  subject: `user:${user}`,
  relation: "read",
  object: "document:d1",
  allowed,
});
const submission = (
  application: string,
  model: string,
  bobAllowed: boolean,
  extra: object = {},
) => ({
  application,
  model,
  tuples,
  assertions: [reads("anne", true), reads("bob", bobAllowed)],
  ...extra,
});

let api: RunningApi;
let call: Call;
let dispose: () => void;

before(async () => {
  const files = fixtureFiles(
    {
      [PLATFORM]: {
        subject: "platform",
        scopes: [
          "applications:write",
          "applications:read",
          "relationships:read",
          "relationships:write",
          "models:read",
          "models:write",
        ],
        applications: ["*"],
      },
      [CHECK]: { subject: "check", scopes: ["check"], applications: ["*"] },
    },
    { [BOB]: "bob", [ANNE]: "anne" },
  );
  dispose = files.dispose;
  api = await startApi({
    ...files.env,
    OPENFGA_API_URL: openfga,
    RIZ_DATABASE_URL: required("RIZ_DATABASE_URL"),
  });
  call = client(api.url);
});

after(async () => {
  await api?.stop();
  dispose?.();
});

/** An application whose live tuples already give bob read through his team. */
async function appWithTuples(): Promise<string> {
  const name = unique("mig");
  const created = await call("POST", "/v1/applications", {
    token: PLATFORM,
    body: { name, environment: "prod" },
  });
  assert.equal(created.status, 201);
  const application = `${name}-prod`;
  const written = await call("POST", "/v1/relationships", {
    token: PLATFORM,
    body: { application, relationships: tuples },
  });
  assert.equal(written.status, 204);
  return application;
}

const models = async (application: string) =>
  (
    await call("GET", `/v1/models?application=${application}`, {
      token: PLATFORM,
    })
  ).body.items as { id: string; active: boolean }[];

async function activeModel(application: string): Promise<string> {
  const active = (await models(application)).filter((m) => m.active);
  assert.equal(active.length, 1);
  return (active[0] as { id: string }).id;
}

const bobReads = async (application: string) =>
  (
    await call("POST", "/v1/check", {
      token: CHECK,
      user: BOB,
      body: readDoc(application, { consistency: "higher_consistency" }),
    })
  ).body;

const submit = (body: object) =>
  call("POST", "/v1/models", { token: PLATFORM, body });

test("a model that does not parse or fit the tuples is rejected and nothing changes", async () => {
  const app = await appWithTuples();
  const before = await models(app);
  const activeBefore = await activeModel(app);

  const garbage = await submit(submission(app, "this is not a model", true));
  assert.equal(garbage.status, 400);
  // A relation the assertions use no longer exists in this model.
  const dropped = await submit(
    submission(app, "model\n  schema 1.1\ntype user\n", true),
  );
  assert.ok([400, 422].includes(dropped.status), `was ${dropped.status}`);

  assert.deepEqual(await models(app), before);
  assert.equal(await activeModel(app), activeBefore);
  assert.equal((await bobReads(app)).status, "allow");
});

test("a model whose assertions fail never becomes active", async () => {
  const app = await appWithTuples();
  const activeBefore = await activeModel(app);

  // Under the tight model bob cannot read, so asserting that he can must fail.
  const wrong = await submit(
    submission(app, tight, true, {
      assertions: [
        reads("anne", true),
        reads("bob", true),
        reads("carol", false),
      ],
    }),
  );
  assert.equal(wrong.status, 422);
  assert.equal(wrong.body.code, "assertions_failed");

  assert.equal(await activeModel(app), activeBefore);
  assert.equal((await models(app)).length, 1);
  assert.equal((await bobReads(app)).status, "allow");
});

test("assertions that only allow, or only deny, are not enough to approve a model", async () => {
  const app = await appWithTuples();
  const onlyAllow = {
    ...submission(app, tight, false),
    assertions: [reads("anne", true)],
  };
  const onlyDeny = {
    ...submission(app, tight, false),
    assertions: [reads("bob", false)],
  };
  assert.equal((await submit(onlyAllow)).status, 400);
  assert.equal((await submit(onlyDeny)).status, 400);
  assert.equal((await models(app)).length, 1);
});

test("an approved model takes effect and rollback restores the earlier decisions", async () => {
  const app = await appWithTuples();
  const first = await activeModel(app);
  assert.equal((await bobReads(app)).status, "allow");

  const done = await submit(submission(app, tight, false));
  assert.equal(done.status, 201);
  const second = done.body.id as string;
  assert.notEqual(second, first);
  assert.equal(await activeModel(app), second);
  const after = await bobReads(app);
  assert.equal(after.status, "deny");
  assert.equal(after.modelId, second);

  const back = await call("POST", "/v1/models/rollback", {
    token: PLATFORM,
    body: { application: app, modelId: first },
  });
  assert.equal(back.status, 200);
  assert.equal(await activeModel(app), first);
  const restored = await bobReads(app);
  assert.equal(restored.status, "allow");
  assert.equal(restored.modelId, first);
});

test("updating one application's model never changes another's decisions", async () => {
  const a = await appWithTuples();
  const b = await appWithTuples();
  const bModel = await activeModel(b);

  assert.equal((await submit(submission(a, tight, false))).status, 201);
  assert.equal((await bobReads(a)).status, "deny");

  const untouched = await bobReads(b);
  assert.equal(untouched.status, "allow");
  assert.equal(untouched.modelId, bModel);
  assert.equal(await activeModel(b), bModel);
  assert.equal((await models(b)).length, 1);
});

test("a model that belongs to another application cannot be rolled back to", async () => {
  const a = await appWithTuples();
  const b = await appWithTuples();
  assert.equal((await submit(submission(b, tight, false))).status, 201);
  const bFirst = (await models(b)).find((m) => !m.active);
  assert.ok(bFirst);

  const activeBefore = await activeModel(a);
  const res = await call("POST", "/v1/models/rollback", {
    token: PLATFORM,
    body: { application: a, modelId: bFirst.id },
  });
  assert.equal(res.status, 404);
  assert.equal(await activeModel(a), activeBefore);
});

test("a newer model written straight to the store is never picked up as latest", async () => {
  const app = await appWithTuples();
  const pinned = await activeModel(app);
  const stores = (await (
    await fetch(`${openfga}/stores?name=${app}`)
  ).json()) as { stores: { id: string }[] };
  const storeId = stores.stores[0]?.id;
  assert.ok(storeId);

  // A model under which nobody can read anything.
  const res = await fetch(`${openfga}/stores/${storeId}/authorization-models`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schema_version: "1.1",
      type_definitions: [{ type: "user" }, { type: "document" }],
    }),
  });
  assert.equal(res.status, 201);
  const newer = ((await res.json()) as { authorization_model_id: string })
    .authorization_model_id;
  assert.notEqual(newer, pinned);

  const decided = await bobReads(app);
  assert.equal(decided.status, "allow");
  assert.equal(decided.modelId, pinned);
  assert.equal(await activeModel(app), pinned);
});
