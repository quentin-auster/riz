import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  ALICE_READS,
  type Call,
  client,
  fixtureFiles,
  type RunningApi,
  readDoc,
  required,
  startApi,
  unique,
} from "./harness.js";

// Revocation freshness (RIZ-040): grant -> check -> revoke -> check under each consistency mode,
// held to the guarantees in docs/architecture.md. riz has no decision cache (RIZ-036 was not
// built), so there is no cache on/off dimension. Needs RIZ_DATABASE_URL and OPENFGA_API_URL.
const PLATFORM = "tok-platform";
const CHECK = "tok-check";
const ALICE = "tok-user-alice";

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
        ],
        applications: ["*"],
      },
      [CHECK]: { subject: "check", scopes: ["check"], applications: ["*"] },
    },
    { [ALICE]: "alice" },
  );
  dispose = files.dispose;
  api = await startApi({
    ...files.env,
    OPENFGA_API_URL: required("OPENFGA_API_URL"),
    RIZ_DATABASE_URL: required("RIZ_DATABASE_URL"),
  });
  call = client(api.url);
});

after(async () => {
  await api?.stop();
  dispose?.();
});

async function register(): Promise<string> {
  const name = unique("rev");
  const res = await call("POST", "/v1/applications", {
    token: PLATFORM,
    body: { name, environment: "prod" },
  });
  assert.equal(res.status, 201);
  return `${name}-prod`;
}

const write = (application: string, relationships: object[]) =>
  call("POST", "/v1/relationships", {
    token: PLATFORM,
    body: { application, relationships },
  });

const revoke = (
  application: string,
  t: { subject: string; relation: string; object: string },
) =>
  call(
    "DELETE",
    `/v1/relationships?application=${application}&subject=${encodeURIComponent(t.subject)}&relation=${t.relation}&object=${encodeURIComponent(t.object)}`,
    { token: PLATFORM },
  );

const decide = async (application: string, consistency?: string) =>
  (
    await call("POST", "/v1/check", {
      token: CHECK,
      user: ALICE,
      body: readDoc(application, consistency ? { consistency } : {}),
    })
  ).body.status;

const decideBatch = async (application: string, consistency: string) => {
  const res = await call("POST", "/v1/batch-check", {
    token: CHECK,
    user: ALICE,
    body: {
      application,
      consistency,
      checks: [{ correlationId: "c", relation: "read", object: "document:d1" }],
    },
  });
  return (res.body.results as { status: string }[])[0]?.status;
};

const [PROJECT_LINK, ALICE_VIEWER] = ALICE_READS as [
  (typeof ALICE_READS)[number],
  (typeof ALICE_READS)[number],
];

test("higher_consistency denies as soon as a revocation is acknowledged", async () => {
  const app = await register();
  assert.equal((await write(app, ALICE_READS)).status, 204);
  assert.equal(await decide(app, "higher_consistency"), "allow");
  assert.equal(await decideBatch(app, "higher_consistency"), "allow");

  assert.equal((await revoke(app, ALICE_VIEWER)).status, 204);
  assert.equal(await decide(app, "higher_consistency"), "deny");
  assert.equal(await decideBatch(app, "higher_consistency"), "deny");
});

test("higher_consistency also sees a revoked link higher in the chain", async () => {
  const app = await register();
  assert.equal((await write(app, ALICE_READS)).status, 204);
  assert.equal(await decide(app, "higher_consistency"), "allow");

  assert.equal((await revoke(app, PROJECT_LINK)).status, 204);
  assert.equal(await decide(app, "higher_consistency"), "deny");
});

test("a grant is visible, and a revocation never turns into an error, in the default and minimize_latency modes", async () => {
  const app = await register();
  assert.equal((await write(app, ALICE_READS)).status, 204);
  for (const mode of [undefined, "minimize_latency"]) {
    assert.equal(await decide(app, mode), "allow", `grant, ${mode}`);
  }
  assert.equal((await revoke(app, ALICE_VIEWER)).status, 204);
  // docs/architecture.md promises nothing about staleness here, so only the shape is held:
  // OpenFGA's cache may still allow, but the answer is a decision and never an error.
  for (const mode of [undefined, "minimize_latency"]) {
    assert.ok(
      ["allow", "deny"].includes((await decide(app, mode)) as string),
      `${mode}`,
    );
  }
  // Whatever the cache holds, the strong mode and the next write path agree on the truth.
  assert.equal(await decide(app, "higher_consistency"), "deny");
});

test("revoking in one application leaves another application's grant alone", async () => {
  const a = await register();
  const b = await register();
  assert.equal((await write(a, ALICE_READS)).status, 204);
  assert.equal((await write(b, ALICE_READS)).status, 204);

  assert.equal((await revoke(a, ALICE_VIEWER)).status, 204);
  assert.equal(await decide(a, "higher_consistency"), "deny");
  assert.equal(await decide(b, "higher_consistency"), "allow");
});

test("a revocation that cannot be applied does not look like success", async () => {
  const app = await register();
  assert.equal((await write(app, ALICE_READS)).status, 204);
  // Revoking something never granted is a 404, so a caller cannot believe it revoked access it did not.
  const missing = await revoke(app, {
    subject: "user:alice",
    relation: "editor",
    object: "project:p1",
  });
  assert.equal(missing.status, 404);
  assert.equal(await decide(app, "higher_consistency"), "allow");
});
