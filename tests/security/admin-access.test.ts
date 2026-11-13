import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  adminStore,
  type Call,
  client,
  type RunningApi,
  readDoc,
  required,
  startApi,
  startApiExpectingExit,
  unique,
} from "./harness.js";

// Admin access in OIDC mode (RIZ-051): a workload administers riz only through a role in the
// riz-admin store, never through the check-only scope every workload gets. Runs the real API with
// a local issuer; needs RIZ_DATABASE_URL and OPENFGA_API_URL. Real IdPs are unverified.
const ISSUER = "https://idp.example.test";
const AUDIENCE = "riz";

let idp: Server;
let api: RunningApi;
let call: Call;
let key: CryptoKey;
let jwksUri: string;

const token = (workload: string, sub = "svc") =>
  new SignJWT({ azp: workload })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(sub)
    .setExpirationTime("5m")
    .sign(key);

const oidcEnv = () => ({
  OPENFGA_API_URL: required("OPENFGA_API_URL"),
  RIZ_DATABASE_URL: required("RIZ_DATABASE_URL"),
  NODE_ENV: "development",
  RIZ_AUTH_MODE: "oidc",
  RIZ_OIDC_ISSUERS: JSON.stringify([
    { issuer: ISSUER, audience: AUDIENCE, jwksUri },
  ]),
});

before(async () => {
  const pair = await generateKeyPair("RS256");
  key = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1" };
  idp = createServer((_, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((r) => idp.listen(0, "127.0.0.1", r));
  jwksUri = `http://127.0.0.1:${(idp.address() as AddressInfo).port}/jwks`;

  api = await startApi({
    ...oidcEnv(),
    ...(await adminStore([
      { issuer: ISSUER, workload: "ops", relation: "security_admin" },
      { issuer: ISSUER, workload: "reader", relation: "auditor" },
    ])),
  });
  call = client(api.url);
});

after(async () => {
  await api?.stop();
  idp?.close();
});

test("a workload with an admin role registers an application and binds a model", async () => {
  const ops = await token("ops");
  const name = unique("adm");
  const created = await call("POST", "/v1/applications", {
    token: ops,
    body: { name, environment: "prod" },
  });
  assert.equal(created.status, 201);

  const bound = await call("POST", "/v1/models", {
    token: ops,
    body: {
      application: `${name}-prod`,
      model: readFileSync(
        join(import.meta.dirname, "../../models/openfga/base.fga"),
        "utf8",
      ),
      tuples: [
        { subject: "project:p1", relation: "project", object: "document:d1" },
        { subject: "user:alice", relation: "viewer", object: "project:p1" },
      ],
      assertions: [
        {
          subject: "user:alice",
          relation: "read",
          object: "document:d1",
          allowed: true,
        },
        {
          subject: "user:bob",
          relation: "read",
          object: "document:d1",
          allowed: false,
        },
      ],
    },
  });
  assert.equal(bound.status, 201);

  const bind = await call("POST", "/v1/workload-bindings", {
    token: ops,
    body: {
      issuer: ISSUER,
      workload: "crm-service",
      application: `${name}-prod`,
    },
  });
  assert.equal(bind.status, 201);
});

test("an admin workload's reach does not carry over to the check path", async () => {
  const ops = await token("ops");
  const name = unique("adm");
  await call("POST", "/v1/applications", {
    token: ops,
    body: { name, environment: "prod" },
  });
  // Administering every application does not bind the workload to any of them for checks.
  const res = await call("POST", "/v1/check", {
    token: ops,
    user: await token("ops", "alice"),
    body: readDoc(`${name}-prod`),
  });
  assert.equal(res.status, 403);
});

test("a check-only workload is refused on every admin route", async () => {
  const stranger = await token("crm-service");
  const routes: [string, string][] = [
    ["GET", "/v1/applications"],
    ["POST", "/v1/applications"],
    ["GET", "/v1/audit"],
    ["GET", "/v1/models?application=x-prod"],
    ["POST", "/v1/models"],
    ["POST", "/v1/models/rollback"],
    ["GET", "/v1/relationships?application=x-prod"],
    ["POST", "/v1/relationships"],
    ["POST", "/v1/workload-bindings"],
    ["DELETE", "/v1/workload-bindings"],
  ];
  for (const [method, path] of routes) {
    const res = await call(method, path, {
      token: stranger,
      ...(method === "GET" ? {} : { body: {} }),
    });
    assert.equal(res.status, 403, `${method} ${path}`);
  }
});

test("an auditor workload reads but cannot register", async () => {
  const reader = await token("reader");
  assert.equal(
    (await call("GET", "/v1/applications", { token: reader })).status,
    200,
  );
  assert.equal((await call("GET", "/v1/audit", { token: reader })).status, 200);
  assert.equal(
    (
      await call("POST", "/v1/applications", {
        token: reader,
        body: { name: unique("adm"), environment: "prod" },
      })
    ).status,
    403,
  );
});

test("admin routes refuse an unauthenticated caller", async () => {
  assert.equal((await call("GET", "/v1/applications")).status, 401);
  assert.equal(
    (await call("GET", "/v1/applications", { token: "not-a-jwt" })).status,
    401,
  );
});

test("in oidc mode the API refuses to start without an admin store", async () => {
  const run = await startApiExpectingExit(oidcEnv());
  assert.notEqual(run.code, 0);
  assert.equal(run.listening, false);
  assert.match(run.output, /RIZ_ADMIN_STORE_ID/);
});
