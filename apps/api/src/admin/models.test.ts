import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { ConsistencyPreference } from "@openfga/sdk";
import { transformer } from "@openfga/syntax-transformer";
import pg from "pg";
import type { Principal } from "../auth/index.js";
import { createResolver, dbLookup } from "../checks/resolver.js";
import { migrate } from "../db/migrate.js";
import { createApp } from "../server.js";
import { modelRoutes } from "./modelRoutes.js";
import { createModelService } from "./models.js";
import { createAdminService } from "./service.js";

// Integration: needs Postgres and OpenFGA. Unverified until run against both.
const url = process.env.RIZ_DATABASE_URL;
const apiUrl = process.env.OPENFGA_API_URL;
const opts = {
  skip: url && apiUrl ? false : "RIZ_DATABASE_URL and OPENFGA_API_URL not set",
};

const principals: Record<string, Principal> = {
  platform: {
    subject: "platform",
    scopes: ["models:write"],
    applications: ["*"],
  },
  crmAdmin: {
    subject: "crm-admin",
    scopes: ["models:write"],
    applications: ["crm-prod"],
  },
  hrAdmin: {
    subject: "hr-admin",
    scopes: ["models:write"],
    applications: ["hr-prod"],
  },
  noScope: { subject: "ns", scopes: ["models:read"], applications: ["*"] },
  crmReader: {
    subject: "crm-reader",
    scopes: ["models:read"],
    applications: ["crm-prod"],
  },
};

const base = readFileSync(
  join(import.meta.dirname, "../../../../models/openfga/base.fga"),
  "utf8",
);
// Same as base except a team no longer grants its members view access to a project.
const tight = base.replace(
  "define viewer: [user] or editor or member from team",
  "define viewer: [user] or editor",
);
assert.notEqual(tight, base);

const fixtureTuples = [
  { subject: "project:p", relation: "project", object: "document:d" },
  { subject: "user:anne", relation: "viewer", object: "project:p" },
  { subject: "team:eng", relation: "team", object: "project:p" },
  { subject: "user:bob", relation: "member", object: "team:eng" },
];
const anneReads = {
  subject: "user:anne",
  relation: "read",
  object: "document:d",
};
const bobReads = {
  subject: "user:bob",
  relation: "read",
  object: "document:d",
};
const submit = (
  model: string,
  bobAllowed: boolean,
  application = "crm-prod",
) => ({
  application,
  model,
  tuples: fixtureTuples,
  assertions: [
    { ...anneReads, allowed: true },
    { ...bobReads, allowed: bobAllowed },
  ],
});

type Call = (
  token: string,
  path: string,
  body: unknown,
) => Promise<{ status: number; body: Record<string, string> | null }>;

async function withApp(
  fn: (ctx: {
    call: Call;
    get: (token: string, path: string) => ReturnType<Call>;
    pool: pg.Pool;
    activeModel: (application: string) => Promise<string>;
    bobCanRead: (application: string) => Promise<boolean>;
    seed: (application: string) => Promise<void>;
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
  const resolver = createResolver(dbLookup(pool), apiUrl as string);
  const server = createApp({
    readiness: async () => [],
    log: () => {},
    authenticate: (h) => principals[h?.replace("Bearer ", "") ?? ""] ?? null,
    routes: modelRoutes(
      createModelService({
        pool,
        lookup: dbLookup(pool),
        apiUrl: apiUrl as string,
      }),
    ),
  });
  try {
    const c = await pool.connect();
    await migrate(c);
    c.release();
    const admin = createAdminService({
      pool,
      apiUrl: apiUrl as string,
      baseModel: transformer.transformDSLToJSONObject(base),
    });
    for (const name of ["crm", "hr"]) {
      await admin.register("platform", { name, environment: "prod" });
    }
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    const call: Call = async (token, path, body) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    const get = async (token: string, path: string) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    const activeModel = async (application: string) =>
      (
        await pool.query(
          "SELECT model_id FROM model_bindings WHERE application_id = $1 AND active",
          [application],
        )
      ).rows[0].model_id;
    const bobCanRead = async (application: string) =>
      (
        await (
          await resolver.clientFor(application)
        ).check(
          { user: "user:bob", relation: "read", object: "document:d" },
          { consistency: ConsistencyPreference.HigherConsistency },
        )
      ).allowed === true;
    // Live tuples, written straight to the application's store at its pinned model.
    const seed = async (application: string) => {
      await (await resolver.clientFor(application)).write({
        writes: fixtureTuples.map((t) => ({
          user: t.subject,
          relation: t.relation,
          object: t.object,
        })),
      });
    };
    await fn({ call, get, pool, activeModel, bobCanRead, seed });
  } finally {
    server.close();
    await pool.end();
    await setup.query(`DROP SCHEMA ${schema} CASCADE`);
    await setup.end();
  }
}

const modelEvents = (pool: pg.Pool) =>
  pool.query(
    "SELECT actor, action, application_id, request_id, detail FROM audit_events WHERE action LIKE 'models.%' ORDER BY id",
  );

test(
  "a submitted model takes effect, and rollback restores the earlier decisions",
  opts,
  () =>
    withApp(async ({ call, pool, activeModel, bobCanRead, seed }) => {
      await seed("crm-prod");
      await seed("hr-prod");
      const first = await activeModel("crm-prod");
      assert.equal(await bobCanRead("crm-prod"), true);

      const done = await call("crmAdmin", "/v1/models", submit(tight, false));
      assert.equal(done.status, 201);
      const second = done.body?.id as string;
      assert.notEqual(second, first);
      assert.equal(await activeModel("crm-prod"), second);
      assert.equal(await bobCanRead("crm-prod"), false);
      // Another application keeps its model and its decisions.
      assert.equal(await bobCanRead("hr-prod"), true);

      const back = await call("crmAdmin", "/v1/models/rollback", {
        application: "crm-prod",
        modelId: first,
      });
      assert.equal(back.status, 200);
      assert.equal(await activeModel("crm-prod"), first);
      assert.equal(await bobCanRead("crm-prod"), true);

      // Both models stay as history, exactly one active.
      const rows = await pool.query(
        "SELECT model_id, active FROM model_bindings WHERE application_id = 'crm-prod'",
      );
      assert.deepEqual(
        rows.rows.map((r) => r.model_id).sort(),
        [first, second].sort(),
      );
      assert.equal(rows.rows.filter((r) => r.active).length, 1);

      const events = await modelEvents(pool);
      assert.deepEqual(
        events.rows.map((r) => [r.actor, r.action, r.application_id]),
        [
          ["crm-admin", "models.bind", "crm-prod"],
          ["crm-admin", "models.rollback", "crm-prod"],
        ],
      );
      assert.ok(events.rows.every((r) => r.request_id));
      assert.deepEqual(events.rows[0].detail, {
        before: { modelId: first },
        after: { modelId: second },
      });
    }),
);

test(
  "a model whose assertions fail is rejected and the binding stays",
  opts,
  () =>
    withApp(async ({ call, pool, activeModel, bobCanRead, seed }) => {
      await seed("crm-prod");
      const before = await activeModel("crm-prod");

      // Under the tight model bob cannot read, so asserting he can must fail.
      const wrong = submit(tight, true);
      wrong.assertions.push({
        subject: "user:carol",
        relation: "read",
        object: "document:d",
        allowed: false,
      });
      const res = await call("crmAdmin", "/v1/models", wrong);
      assert.equal(res.status, 422);
      assert.equal(res.body?.code, "assertions_failed");
      assert.match(res.body?.message ?? "", /#1/);

      assert.equal(await activeModel("crm-prod"), before);
      assert.equal(await bobCanRead("crm-prod"), true);
      assert.equal((await modelEvents(pool)).rowCount, 0);
      const { rows } = await pool.query(
        "SELECT count(*)::int AS n FROM model_bindings WHERE application_id = 'crm-prod'",
      );
      assert.equal(rows[0].n, 1);
    }),
);

test("malformed submissions are 400 and change nothing", opts, () =>
  withApp(async ({ call, pool, activeModel }) => {
    const before = await activeModel("crm-prod");
    const good = submit(tight, false);
    for (const [name, body] of Object.entries({
      "does not parse": { ...good, model: "model\n  schema 1.1\ntype" },
      "only allow assertions": {
        ...good,
        assertions: [{ ...anneReads, allowed: true }],
      },
      "only deny assertions": {
        ...good,
        assertions: [{ ...bobReads, allowed: false }],
      },
      "no assertions": { ...good, assertions: [] },
      "unknown field": { ...good, latest: true },
      "assertion without allowed": {
        ...good,
        assertions: [anneReads, { ...bobReads, allowed: false }],
      },
      "tuple the model forbids": {
        ...good,
        tuples: [{ ...fixtureTuples[3], object: "spaceship:enterprise" }],
      },
    })) {
      const res = await call("crmAdmin", "/v1/models", body);
      assert.equal(res.status, 400, name);
    }
    for (const body of [
      { application: "crm-prod", modelId: "latest" },
      { application: "crm-prod", modelId: before, extra: 1 },
    ]) {
      assert.equal(
        (await call("crmAdmin", "/v1/models/rollback", body)).status,
        400,
      );
    }
    assert.equal(await activeModel("crm-prod"), before);
    assert.equal((await modelEvents(pool)).rowCount, 0);
  }),
);

test("a caller who is not an admin of the application gets 403", opts, () =>
  withApp(async ({ call, pool, activeModel }) => {
    const before = await activeModel("crm-prod");
    const attempts: [string, string, unknown][] = [
      ["noScope", "/v1/models", submit(tight, false)],
      // An admin of another application, and an application that does not exist.
      ["hrAdmin", "/v1/models", submit(tight, false)],
      ["hrAdmin", "/v1/models", submit(tight, false, "nope-prod")],
      [
        "noScope",
        "/v1/models/rollback",
        { application: "crm-prod", modelId: before },
      ],
      [
        "hrAdmin",
        "/v1/models/rollback",
        { application: "crm-prod", modelId: before },
      ],
    ];
    for (const [who, path, body] of attempts) {
      assert.equal((await call(who, path, body)).status, 403, `${who} ${path}`);
    }
    assert.equal(await activeModel("crm-prod"), before);
    assert.equal((await modelEvents(pool)).rowCount, 0);
  }),
);

test(
  "rollback of an unknown model is 404 and of the active model is 409",
  opts,
  () =>
    withApp(async ({ call, activeModel }) => {
      const active = await activeModel("crm-prod");
      const rollback = (modelId: string, application = "crm-prod") =>
        call("platform", "/v1/models/rollback", { application, modelId });
      assert.equal((await rollback("01ARZ3NDEKTSV4RRFFQ69G5FAV")).status, 404);
      assert.equal((await rollback(active)).status, 409);
      assert.equal((await rollback(active, "nope-prod")).status, 404);
    }),
);

test("a binding whose audit write fails is not changed", opts, () =>
  withApp(async ({ call, pool, activeModel, bobCanRead, seed }) => {
    await seed("crm-prod");
    const before = await activeModel("crm-prod");
    await pool.query(`
      CREATE FUNCTION fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'audit store down'; END $$;
      CREATE TRIGGER audit_down BEFORE INSERT ON audit_events
        FOR EACH ROW EXECUTE FUNCTION fail_audit();
    `);
    const res = await call("crmAdmin", "/v1/models", submit(tight, false));
    assert.equal(res.status, 500);
    assert.equal(await activeModel("crm-prod"), before);
    assert.equal(await bobCanRead("crm-prod"), true);
  }),
);

test(
  "a bound model can be read as DSL, so versions can be compared",
  opts,
  () =>
    withApp(async ({ call, get, activeModel }) => {
      const first = await activeModel("crm-prod");
      const second = (
        await call("crmAdmin", "/v1/models", submit(tight, false))
      ).body?.id as string;

      const older = await get(
        "crmReader",
        `/v1/models/${first}?application=crm-prod`,
      );
      const newer = await get(
        "crmReader",
        `/v1/models/${second}?application=crm-prod`,
      );
      assert.equal(older.status, 200);
      assert.equal(newer.status, 200);
      assert.match(older.body?.model as string, /or member from team/);
      assert.doesNotMatch(newer.body?.model as string, /or member from team/);
    }),
);

test(
  "a model cannot be read without models:read, outside the allow-list, or through another application",
  opts,
  () =>
    withApp(async ({ get, activeModel }) => {
      const crm = await activeModel("crm-prod");
      const hr = await activeModel("hr-prod");
      const path = (id: string, application: string) =>
        `/v1/models/${id}?application=${application}`;

      // models:write alone does not read; another application's admin is refused.
      assert.equal((await get("crmAdmin", path(crm, "crm-prod"))).status, 403);
      assert.equal((await get("crmReader", path(hr, "hr-prod"))).status, 403);
      // A model of one application is not readable under another.
      assert.equal((await get("noScope", path(crm, "hr-prod"))).status, 404);
      assert.equal(
        (await get("noScope", `/v1/models/${crm}?application=nope-prod`))
          .status,
        404,
      );
    }),
);
