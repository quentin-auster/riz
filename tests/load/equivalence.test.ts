import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

// Black-box suite against N API replicas behind a load balancer that tags each response with
// the replica that served it: `docker compose --profile replicas up -d --build --wait lb`,
// then `pnpm --filter @riz/api test:replicas` with RIZ_LB_URL=http://localhost:8090.
// Fixture tokens are the dev-only values in deploy/fixtures.
const lb = process.env.RIZ_LB_URL;
if (!lb) throw new Error("RIZ_LB_URL is required");
const minReplicas = Number(process.env.RIZ_REPLICAS ?? 2);

const ADMIN = "dev-admin-token";
const CHECK = "dev-check-token";
const ALICE = "dev-alice-token";
const ROUNDS = 12;

type Json = Record<string, unknown>;

async function call(
  method: string,
  path: string,
  opts: { token?: string; user?: string; body?: unknown } = {},
) {
  const res = await fetch(`${lb}${path}`, {
    method,
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.user ? { "riz-end-user-token": opts.user } : {}),
      "content-type": "application/json",
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const body = (await res.json().catch(() => ({}))) as Json;
  // requestId is unique per request by design; everything else must match across replicas.
  delete body.requestId;
  return {
    status: res.status,
    body,
    replica: res.headers.get("x-riz-replica"),
  };
}

test("every replica gives the same answers, and requests are spread across them", async () => {
  const name = `eq${randomBytes(6).toString("hex")}`;
  const created = await call("POST", "/v1/applications", {
    token: ADMIN,
    body: { name, environment: "prod" },
  });
  assert.equal(created.status, 201);
  const app = created.body.id as string;

  const granted = await call("POST", "/v1/relationships", {
    token: ADMIN,
    body: {
      application: app,
      relationships: [
        { subject: "project:p1", relation: "project", object: "document:d1" },
        { subject: "user:alice", relation: "viewer", object: "project:p1" },
      ],
    },
  });
  assert.equal(granted.status, 204);

  const read = (object: string) => ({
    application: app,
    relation: "read",
    object,
  });
  const requests = [
    {
      name: "allowed check",
      send: () =>
        call("POST", "/v1/check", {
          token: CHECK,
          user: ALICE,
          body: read("document:d1"),
        }),
      status: 200,
      decision: "allow",
    },
    {
      name: "denied check",
      send: () =>
        call("POST", "/v1/check", {
          token: CHECK,
          user: ALICE,
          body: read("document:d2"),
        }),
      status: 200,
      decision: "deny",
    },
    {
      name: "batch",
      send: () =>
        call("POST", "/v1/batch-check", {
          token: CHECK,
          user: ALICE,
          body: {
            application: app,
            checks: [
              { correlationId: "a", relation: "read", object: "document:d1" },
              { correlationId: "b", relation: "read", object: "document:d2" },
            ],
          },
        }),
      status: 200,
    },
    {
      name: "unauthenticated",
      send: () => call("POST", "/v1/check", { body: read("document:d1") }),
      status: 401,
    },
    {
      name: "unknown application",
      send: () =>
        call("POST", "/v1/check", {
          token: CHECK,
          user: ALICE,
          body: { ...read("document:d1"), application: "no-such-app-prod" },
        }),
      status: 404,
    },
  ];

  const seen = new Set<string>();
  for (const request of requests) {
    const answers = [];
    for (let i = 0; i < ROUNDS; i++) {
      const answer = await request.send();
      assert.ok(answer.replica, "the LB must tag the replica");
      seen.add(answer.replica);
      answers.push(answer);
    }
    const [first] = answers;
    assert.equal(first?.status, request.status, request.name);
    if (request.decision) {
      assert.equal(first?.body.status, request.decision, request.name);
    }
    for (const answer of answers) {
      assert.equal(answer.status, first?.status, request.name);
      assert.deepEqual(answer.body, first?.body, request.name);
    }
  }
  assert.ok(
    seen.size >= minReplicas,
    `requests reached ${seen.size} replicas (${[...seen]}), expected at least ${minReplicas}`,
  );
});
