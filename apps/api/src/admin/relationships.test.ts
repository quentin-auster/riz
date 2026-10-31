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
import { relationshipRoutes } from "./relationshipRoutes.js";
import { createRelationshipService } from "./relationships.js";
import { createAdminService } from "./service.js";

// Integration: needs Postgres and OpenFGA. Unverified until run against both.
const url = process.env.RIZ_DATABASE_URL;
const apiUrl = process.env.OPENFGA_API_URL;
const opts = {
  skip: url && apiUrl ? false : "RIZ_DATABASE_URL and OPENFGA_API_URL not set",
};

const WRITE = ["relationships:read", "relationships:write"];
const principals: Record<string, Principal> = {
  platform: { subject: "platform", scopes: WRITE, applications: ["*"] },
  crmAdmin: { subject: "crm-admin", scopes: WRITE, applications: ["crm-prod"] },
  hrAdmin: { subject: "hr-admin", scopes: WRITE, applications: ["hr-prod"] },
  readOnly: {
    subject: "reader",
    scopes: ["relationships:read"],
    applications: ["crm-prod"],
  },
  noScope: { subject: "ns", scopes: [], applications: ["*"] },
};

type Call = (
  token: string,
  method: string,
  path: string,
  body?: unknown,
) => Promise<{ status: number; body: Json }>;

type Json = {
  nextCursor?: string;
  items: { subject: string; relation: string; object: string }[];
};

const tuple = {
  subject: "user:anne",
  relation: "member",
  object: "team:eng",
};
const write = (relationships: unknown[], application = "crm-prod") => ({
  application,
  relationships,
});
const deletePath = (t = tuple, application = "crm-prod") =>
  `/v1/relationships?application=${application}&subject=${encodeURIComponent(
    t.subject,
  )}&relation=${t.relation}&object=${encodeURIComponent(t.object)}`;

async function withApp(
  fn: (ctx: {
    call: Call;
    pool: pg.Pool;
    resolver: ReturnType<typeof createResolver>;
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
    routes: relationshipRoutes(createRelationshipService({ pool, resolver })),
  });
  try {
    const c = await pool.connect();
    await migrate(c);
    c.release();
    const admin = createAdminService({
      pool,
      apiUrl: apiUrl as string,
      baseModel: transformer.transformDSLToJSONObject(
        readFileSync(
          join(import.meta.dirname, "../../../../models/openfga/base.fga"),
          "utf8",
        ),
      ),
    });
    for (const name of ["crm", "hr"]) {
      await admin.register("platform", { name, environment: "prod" });
    }
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    const call: Call = async (token, method, path, body) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    await fn({ call, pool, resolver });
  } finally {
    server.close();
    await pool.end();
    await setup.query(`DROP SCHEMA ${schema} CASCADE`);
    await setup.end();
  }
}

const isMember = async (
  resolver: ReturnType<typeof createResolver>,
  application: string,
) =>
  (
    await (
      await resolver.clientFor(application)
    ).check(
      { user: "user:anne", relation: "member", object: "team:eng" },
      { consistency: ConsistencyPreference.HigherConsistency },
    )
  ).allowed;

test(
  "a granted relationship allows; a revoked one denies at higher consistency",
  opts,
  () =>
    withApp(async ({ call, resolver }) => {
      assert.equal(await isMember(resolver, "crm-prod"), false);

      const granted = await call(
        "crmAdmin",
        "POST",
        "/v1/relationships",
        write([tuple]),
      );
      assert.equal(granted.status, 204);
      assert.equal(await isMember(resolver, "crm-prod"), true);

      const listed = await call(
        "crmAdmin",
        "GET",
        "/v1/relationships?application=crm-prod&object=team%3Aeng&relation=member",
      );
      assert.deepEqual(listed.body.items, [tuple]);
      // A type alone, or a relation without an object, cannot be listed.
      for (const query of ["object=team%3A", "relation=member"]) {
        const path = `/v1/relationships?application=crm-prod&${query}`;
        assert.equal((await call("crmAdmin", "GET", path)).status, 400, query);
      }

      assert.equal(
        (await call("crmAdmin", "DELETE", deletePath())).status,
        204,
      );
      assert.equal(await isMember(resolver, "crm-prod"), false);
    }),
);

test(
  "a caller who is not an admin of the application gets 403 and changes nothing",
  opts,
  () =>
    withApp(async ({ call, resolver, pool }) => {
      const attempts: [string, string, string, unknown?][] = [
        ["noScope", "POST", "/v1/relationships", write([tuple])],
        ["readOnly", "POST", "/v1/relationships", write([tuple])],
        // An admin of another application, and an application that does not exist.
        ["hrAdmin", "POST", "/v1/relationships", write([tuple])],
        ["hrAdmin", "POST", "/v1/relationships", write([tuple], "nope-prod")],
        ["readOnly", "DELETE", deletePath()],
        ["hrAdmin", "GET", "/v1/relationships?application=crm-prod"],
        ["noScope", "GET", "/v1/relationships?application=crm-prod"],
      ];
      for (const [who, method, path, body] of attempts) {
        assert.equal(
          (await call(who, method, path, body)).status,
          403,
          `${who} ${method} ${path}`,
        );
      }
      assert.equal(await isMember(resolver, "crm-prod"), false);
      const { rows } = await pool.query(
        "SELECT count(*)::int AS n FROM audit_events WHERE action LIKE 'relationships.%'",
      );
      assert.equal(rows[0].n, 0);
    }),
);

test(
  "a tuple for an unknown type or relation, or one the model forbids, is rejected",
  opts,
  () =>
    withApp(async ({ call, pool }) => {
      for (const bad of [
        { ...tuple, object: "spaceship:enterprise" },
        { ...tuple, relation: "captain" },
        // team#member takes users, not teams.
        { ...tuple, subject: "team:ops" },
      ]) {
        const res = await call(
          "crmAdmin",
          "POST",
          "/v1/relationships",
          write([bad]),
        );
        assert.equal(res.status, 400, JSON.stringify(bad));
      }
      const { rows } = await pool.query(
        "SELECT count(*)::int AS n FROM audit_events WHERE action LIKE 'relationships.%'",
      );
      assert.equal(rows[0].n, 0, "a rejected write leaves no audit event");

      for (const body of [
        { application: "crm-prod", relationships: [] },
        { application: "crm-prod", relationships: [{ ...tuple, extra: 1 }] },
        { application: "crm-prod", relationships: [tuple], user: "user:x" },
        write([{ ...tuple, subject: "user:anne#" }]),
      ]) {
        assert.equal(
          (await call("crmAdmin", "POST", "/v1/relationships", body)).status,
          400,
        );
      }
    }),
);

test(
  "a duplicate grant is 409 and deleting a missing relationship is 404",
  opts,
  () =>
    withApp(async ({ call }) => {
      assert.equal(
        (await call("crmAdmin", "DELETE", deletePath())).status,
        404,
      );
      await call("crmAdmin", "POST", "/v1/relationships", write([tuple]));
      assert.equal(
        (await call("crmAdmin", "POST", "/v1/relationships", write([tuple])))
          .status,
        409,
      );
      assert.equal(
        (
          await call(
            "platform",
            "GET",
            "/v1/relationships?application=nope-prod",
          )
        ).status,
        404,
      );
    }),
);

test(
  "each write and delete is audited with its request and before/after",
  opts,
  () =>
    withApp(async ({ call, pool }) => {
      await call("crmAdmin", "POST", "/v1/relationships", write([tuple]));
      await call("crmAdmin", "DELETE", deletePath());

      const { rows } = await pool.query(
        `SELECT actor, action, application_id, request_id, detail
         FROM audit_events WHERE action LIKE 'relationships.%' ORDER BY id`,
      );
      assert.deepEqual(
        rows.map((r) => [r.actor, r.action, r.application_id]),
        [
          ["crm-admin", "relationships.write", "crm-prod"],
          ["crm-admin", "relationships.delete", "crm-prod"],
        ],
      );
      assert.ok(rows.every((r) => r.request_id));
      assert.deepEqual(rows[0].detail, { before: null, after: [tuple] });
      assert.deepEqual(rows[1].detail, { before: tuple, after: null });
    }),
);

test("a grant whose audit write fails is not applied", opts, () =>
  withApp(async ({ call, pool, resolver }) => {
    await pool.query(`
      CREATE FUNCTION fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'audit store down'; END $$;
      CREATE TRIGGER audit_down BEFORE INSERT ON audit_events
        FOR EACH ROW EXECUTE FUNCTION fail_audit();
    `);
    const res = await call(
      "crmAdmin",
      "POST",
      "/v1/relationships",
      write([tuple]),
    );
    assert.equal(res.status, 500);
    assert.equal(await isMember(resolver, "crm-prod"), false);
  }),
);

test("an unreachable OpenFGA is a 503 and leaves no audit event", opts, () =>
  withApp(async ({ pool }) => {
    const down = createRelationshipService({
      pool,
      resolver: createResolver(
        async () => ({
          storeId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          modelId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        }),
        "http://127.0.0.1:1",
      ),
    });
    await assert.rejects(down.write("crm-admin", "crm-prod", [tuple]), {
      status: 503,
      code: "authorization_unavailable",
    });
    await assert.rejects(down.list("crm-prod", {}, { limit: 10 }), {
      status: 503,
    });
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM audit_events WHERE action LIKE 'relationships.%'",
    );
    assert.equal(rows[0].n, 0);
  }),
);
