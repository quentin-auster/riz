import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  ALICE_READS,
  type Call,
  client,
  type Fault,
  type FaultProxy,
  fixtureFiles,
  proxied,
  type RunningApi,
  readDoc,
  required,
  startApi,
  unique,
} from "./harness.js";

// Outage and fail-closed behaviour (RIZ-041): OpenFGA or Postgres severed (connections refused
// at once) or blackholed (accepted, never answered) must never produce an allow. The faults
// are injected by a TCP proxy in front of each dependency (harness.ts), so a replica's network
// partition from OpenFGA is the same fault as `drop`. Needs RIZ_DATABASE_URL and OPENFGA_API_URL.
// Not covered here: a partial batch failure needs OpenFGA to answer some items and not others,
// which a real OpenFGA will not do on demand; it is covered with a stub in
// apps/api/src/checks/check.test.ts ("a failed or missing batch item is indeterminate ...").
// The SDKs raising on `indeterminate` is covered by tests/conformance/cases/*indeterminate*.json.
const PLATFORM = "tok-platform";
const CHECK = "tok-check";
const ALICE = "tok-user-alice";
const TIMEOUT_MS = 500;

let api: RunningApi;
let call: Call;
let fga: FaultProxy;
let postgres: FaultProxy;
let dispose: () => void;
let app: string;

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
  const fgaUrl = await proxied(required("OPENFGA_API_URL"), 80);
  const pgUrl = await proxied(required("RIZ_DATABASE_URL"), 5432);
  fga = fgaUrl.proxy;
  postgres = pgUrl.proxy;
  api = await startApi({
    ...files.env,
    OPENFGA_API_URL: fgaUrl.url,
    RIZ_DATABASE_URL: pgUrl.url,
    RIZ_CHECK_TIMEOUT_MS: String(TIMEOUT_MS),
    RIZ_READY_TIMEOUT_MS: String(TIMEOUT_MS),
  });
  call = client(api.url);

  const name = unique("out");
  app = `${name}-prod`;
  const registered = await call("POST", "/v1/applications", {
    token: PLATFORM,
    body: { name, environment: "prod" },
  });
  assert.equal(registered.status, 201);
  const granted = await call("POST", "/v1/relationships", {
    token: PLATFORM,
    body: { application: app, relationships: ALICE_READS },
  });
  assert.equal(granted.status, 204);
});

after(async () => {
  await api?.stop();
  fga?.close();
  postgres?.close();
  dispose?.();
});

const single = () =>
  call("POST", "/v1/check", { token: CHECK, user: ALICE, body: readDoc(app) });
const batch = () =>
  call("POST", "/v1/batch-check", {
    token: CHECK,
    user: ALICE,
    body: {
      application: app,
      checks: [
        { correlationId: "a", relation: "read", object: "document:d1" },
        { correlationId: "b", relation: "delete", object: "document:d1" },
      ],
    },
  });

/** Every decision returned while a fault is injected, over repeated single and batch checks. */
async function decisionsDuring(fault: Fault, proxy: FaultProxy) {
  proxy.set(fault);
  try {
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      const one = await single();
      assert.equal(one.status, 200);
      seen.push(one.body.status as string);
      const many = await batch();
      assert.equal(many.status, 200);
      for (const r of many.body.results as { status: string }[]) {
        seen.push(r.status);
      }
    }
    return { seen, one: await single() };
  } finally {
    proxy.set("pass");
  }
}

/** The path works again once the dependency is back; a stale pooled socket may fail one try. */
async function allowsAgain() {
  for (let i = 0; i < 10; i++) {
    if ((await single()).body.status === "allow") return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

test("the healthy path allows, so the fault tests prove something", async () => {
  assert.equal((await single()).body.status, "allow");
  const results = (await batch()).body.results as { status: string }[];
  assert.deepEqual(
    results.map((r) => r.status),
    ["allow", "deny"],
  );
});

test("with OpenFGA down, every check and batch item is indeterminate and none is allowed", async () => {
  const { seen, one } = await decisionsDuring("drop", fga);
  assert.deepEqual([...new Set(seen)], ["indeterminate"]);
  assert.equal(one.body.code, "backend_error");
  assert.ok(await allowsAgain(), "access resumes when OpenFGA returns");
});

test("with OpenFGA unresponsive, checks time out as indeterminate within the bound", async () => {
  const started = Date.now();
  const { seen, one } = await decisionsDuring("hang", fga);
  assert.deepEqual([...new Set(seen)], ["indeterminate"]);
  assert.equal(one.body.code, "timeout");
  // 7 sequential requests, each bounded by the timeout; the margin covers process scheduling.
  assert.ok(Date.now() - started < 7 * TIMEOUT_MS + 5000);
  assert.ok(await allowsAgain(), "access resumes when OpenFGA answers again");
});

test("with Postgres down, checks are indeterminate, readiness fails, and nothing is written", async () => {
  const { seen, one } = await decisionsDuring("drop", postgres);
  assert.deepEqual([...new Set(seen)], ["indeterminate"]);
  assert.equal(one.body.code, "backend_error");

  postgres.set("drop");
  try {
    assert.equal((await call("GET", "/health/ready")).status, 503);
    const write = await call("POST", "/v1/relationships", {
      token: PLATFORM,
      body: {
        application: app,
        relationships: [
          { subject: "user:eve", relation: "viewer", object: "project:p1" },
        ],
      },
    });
    assert.ok(write.status >= 500, `write during outage was ${write.status}`);
  } finally {
    postgres.set("pass");
  }
  assert.ok(await allowsAgain(), "access resumes when Postgres returns");
  const list = await call("GET", `/v1/relationships?application=${app}`, {
    token: PLATFORM,
  });
  const subjects = (list.body.items as { subject: string }[]).map(
    (t) => t.subject,
  );
  assert.ok(!subjects.includes("user:eve"));
});

test("with both dependencies down, the answer is still never an allow", async () => {
  fga.set("hang");
  postgres.set("drop");
  try {
    const seen = [(await single()).body.status, ...(await resultsOfBatch())];
    assert.deepEqual([...new Set(seen)], ["indeterminate"]);
  } finally {
    fga.set("pass");
    postgres.set("pass");
  }
  assert.ok(await allowsAgain());
});

async function resultsOfBatch() {
  return ((await batch()).body.results as { status: string }[]).map(
    (r) => r.status,
  );
}
