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

// Privilege escalation and tenant isolation (RIZ-039): applications and admins stay in their lanes.
// Needs Postgres and OpenFGA: RIZ_DATABASE_URL and OPENFGA_API_URL.
const openfga = required("OPENFGA_API_URL");

const nameA = unique("seca");
const nameB = unique("secb");
const A = `${nameA}-prod`;
const B = `${nameB}-prod`;

const ADMIN_SCOPES = [
  "applications:read",
  "relationships:read",
  "relationships:write",
  "models:read",
  "models:write",
  "audit:read",
];
const PLATFORM = "tok-platform";
const ADMIN_A = "tok-admin-a";
const READER_A = "tok-reader-a";
const CHECK_A = "tok-check-a";
const CHECK_ALL = "tok-check-all";
const NO_SCOPE = "tok-lookalike-scopes";
const ALICE = "tok-user-alice";
const MALLORY = "tok-user-mallory";

let api: RunningApi;
let call: Call;
let dispose: () => void;

before(async () => {
  const files = fixtureFiles(
    {
      [PLATFORM]: {
        subject: "platform",
        scopes: [
          ...ADMIN_SCOPES,
          "applications:write",
          "bindings:write",
          "explorer:check",
        ],
        applications: ["*"],
      },
      [ADMIN_A]: {
        subject: "admin-a",
        scopes: ADMIN_SCOPES,
        applications: [A],
      },
      [READER_A]: {
        subject: "reader-a",
        scopes: ["relationships:read", "models:read"],
        applications: [A],
      },
      [CHECK_A]: { subject: "check-a", scopes: ["check"], applications: [A] },
      [CHECK_ALL]: {
        subject: "check-all",
        scopes: ["check"],
        applications: ["*"],
      },
      [NO_SCOPE]: {
        subject: "lookalike",
        scopes: ["relationships:*", "admin", "*", "relationships:write:x"],
        applications: ["*"],
      },
    },
    { [ALICE]: "alice", [MALLORY]: "mallory" },
  );
  dispose = files.dispose;
  api = await startApi({
    ...files.env,
    OPENFGA_API_URL: openfga,
    RIZ_DATABASE_URL: required("RIZ_DATABASE_URL"),
  });
  call = client(api.url);
  for (const name of [nameA, nameB]) {
    const res = await call("POST", "/v1/applications", {
      token: PLATFORM,
      body: { name, environment: "prod" },
    });
    assert.equal(res.status, 201);
  }
});

after(async () => {
  await api?.stop();
  dispose?.();
});

const check = (token: string, application: string, user = ALICE) =>
  call("POST", "/v1/check", { token, user, body: readDoc(application) });

const grant = (token: string, application: string, relationships: object[]) =>
  call("POST", "/v1/relationships", {
    token,
    body: { application, relationships },
  });

test("a tuple written for one application is invisible to another with identical IDs", async () => {
  assert.equal((await grant(PLATFORM, A, ALICE_READS)).status, 204);
  assert.equal((await check(CHECK_ALL, A)).body.status, "allow");
  assert.equal((await check(CHECK_ALL, B)).body.status, "deny");
});

test("a workload scoped to one application is refused on another, whether or not it exists", async () => {
  assert.equal((await check(CHECK_A, A)).status, 200);
  for (const other of [B, "nope-prod"]) {
    assert.equal((await check(CHECK_A, other)).status, 403, `check ${other}`);
    const batch = await call("POST", "/v1/batch-check", {
      token: CHECK_A,
      user: ALICE,
      body: {
        application: other,
        checks: [
          { correlationId: "c", relation: "read", object: "document:d1" },
        ],
      },
    });
    assert.equal(batch.status, 403, `batch ${other}`);
  }
});

test("an administrator scoped to one application cannot read or change another", async () => {
  const other = encodeURIComponent(B);
  const tuple = ALICE_READS[1] as (typeof ALICE_READS)[number];
  const denied = [
    await call("GET", `/v1/relationships?application=${other}`, {
      token: ADMIN_A,
    }),
    await grant(ADMIN_A, B, ALICE_READS),
    await call(
      "DELETE",
      `/v1/relationships?application=${other}&subject=${encodeURIComponent(tuple.subject)}&relation=${tuple.relation}&object=${tuple.object}`,
      { token: ADMIN_A },
    ),
    await call("POST", "/v1/models/rollback", {
      token: ADMIN_A,
      body: { application: B, modelId: "0".repeat(26) },
    }),
  ];
  for (const res of denied) assert.equal(res.status, 403);
  // These read routes answer 404 for an application outside the allow-list, so they do not
  // confirm that it exists.
  for (const path of [
    `/v1/models?application=${other}`,
    `/v1/applications/${B}`,
  ]) {
    const { status } = await call("GET", path, { token: ADMIN_A });
    assert.ok([403, 404].includes(status), `${path} was ${status}`);
  }
  // Audit filters by the allow-list instead: B has events (its registration), A's admin sees none.
  const auditOf = async (token: string) =>
    (
      (await call("GET", `/v1/audit?application=${other}&limit=100`, { token }))
        .body.items as unknown[]
    ).length;
  assert.ok((await auditOf(PLATFORM)) > 0);
  assert.equal(await auditOf(ADMIN_A), 0);

  // Nothing leaked into B, and its decisions did not change.
  const list = await call("GET", `/v1/relationships?application=${B}`, {
    token: PLATFORM,
  });
  assert.deepEqual(list.body.items, []);
  assert.equal((await check(CHECK_ALL, B)).body.status, "deny");
});

test("store and model IDs supplied by a caller are rejected or ignored", async () => {
  const stores = (await (
    await fetch(`${openfga}/stores?name=${A}`)
  ).json()) as {
    stores: { id: string }[];
  };
  const storeA = stores.stores[0]?.id as string;
  assert.ok(storeA);
  const modelsA = await call("GET", `/v1/models?application=${A}`, {
    token: PLATFORM,
  });
  const modelA = (modelsA.body.items as { id: string }[])[0]?.id as string;

  for (const field of [
    "storeId",
    "store_id",
    "authorizationModelId",
    "modelId",
    "model_id",
  ]) {
    const value = field.toLowerCase().includes("model") ? modelA : storeA;
    const body = readDoc(B, { [field]: value });
    const single = await call("POST", "/v1/check", {
      token: CHECK_ALL,
      user: ALICE,
      body,
    });
    assert.equal(single.status, 400, `check ${field}`);
    const batch = await call("POST", "/v1/batch-check", {
      token: CHECK_ALL,
      user: ALICE,
      body: {
        application: B,
        checks: [
          { correlationId: "c", relation: "read", object: "document:d1" },
        ],
        [field]: value,
      },
    });
    assert.equal(batch.status, 400, `batch ${field}`);
    const write = await call("POST", "/v1/relationships", {
      token: PLATFORM,
      body: { application: B, relationships: ALICE_READS, [field]: value },
    });
    assert.equal(write.status, 400, `relationships ${field}`);
    const register = await call("POST", "/v1/applications", {
      token: PLATFORM,
      body: { name: unique("x"), environment: "prod", [field]: value },
    });
    assert.equal(register.status, 400, `register ${field}`);
  }

  // The same IDs in a header or the query string are not read: B still decides on its own store.
  const viaHeaders = await call("POST", `/v1/check?storeId=${storeA}`, {
    token: CHECK_ALL,
    user: ALICE,
    body: readDoc(B),
    headers: {
      "openfga-store-id": storeA,
      "x-store-id": storeA,
      "x-authorization-model-id": modelA,
    },
  });
  assert.equal(viaHeaders.status, 200);
  assert.equal(viaHeaders.body.status, "deny");
  assert.notEqual(viaHeaders.body.modelId, modelA);
});

test("a token without the exact admin scope cannot use admin routes", async () => {
  const body = { application: A, relationships: ALICE_READS };
  const extra = {
    application: A,
    relationships: [
      { subject: "user:eve", relation: "viewer", object: "project:p1" },
    ],
  };
  const attempts = [
    // Read-only and look-alike scopes cannot write, even on the allowed application.
    await call("POST", "/v1/relationships", { token: READER_A, body: extra }),
    await call("POST", "/v1/relationships", { token: NO_SCOPE, body: extra }),
    // A check-only workload reaches no administrative route.
    await call("POST", "/v1/relationships", { token: CHECK_A, body }),
    await call("POST", "/v1/models", { token: CHECK_A, body: {} }),
    await call("POST", "/v1/applications", {
      token: CHECK_A,
      body: { name: unique("x"), environment: "prod" },
    }),
    await call("GET", `/v1/audit?application=${A}`, { token: CHECK_A }),
    await call("POST", "/v1/workload-bindings", {
      token: CHECK_A,
      body: { issuer: "https://idp.test", workload: "w", application: A },
    }),
  ];
  for (const res of attempts) assert.equal(res.status, 403);

  const list = await call("GET", `/v1/relationships?application=${A}`, {
    token: PLATFORM,
  });
  const subjects = (list.body.items as { subject: string }[]).map(
    (t) => t.subject,
  );
  assert.ok(!subjects.includes("user:eve"));
});

test("an application administrator cannot widen its reach or make itself an organization admin elsewhere", async () => {
  // It may not register applications or change which applications a workload reaches.
  const register = await call("POST", "/v1/applications", {
    token: ADMIN_A,
    body: { name: unique("x"), environment: "prod" },
  });
  assert.equal(register.status, 403);
  const bind = await call("POST", "/v1/workload-bindings", {
    token: ADMIN_A,
    body: { issuer: "https://idp.test", workload: "w", application: B },
  });
  assert.equal(bind.status, 403);

  // Inside its own application it may write organization tuples; they confer nothing on B.
  const orgAdmin = [
    {
      subject: "organization:acme",
      relation: "organization",
      object: `application:${A}`,
    },
    { subject: "user:mallory", relation: "admin", object: "organization:acme" },
  ];
  assert.equal((await grant(ADMIN_A, A, orgAdmin)).status, 204);
  const adminOf = (application: string) =>
    call("POST", "/v1/check", {
      token: CHECK_ALL,
      user: MALLORY,
      body: {
        application,
        relation: "admin",
        object: `application:${application}`,
      },
    });
  assert.equal((await adminOf(A)).body.status, "allow");
  assert.equal((await adminOf(B)).body.status, "deny");
  assert.equal(
    (await grant(ADMIN_A, B, orgAdmin)).status,
    403,
    "writing the same tuples to B is refused",
  );
});
