import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { checkRoutes } from "../checks/routes.js";
import type { CheckService } from "../checks/service.js";
import { createApp } from "../server.js";
import { oidcTokenVerifier } from "./oidc.js";
import { oidcEndUserVerifier, workloadAuthenticator } from "./workloads.js";

const ISSUER = "https://idp.example.test";

let idp: Server;
let api: Server;
let privateKey: CryptoKey;
let port: number;
// Who the check service was asked about: [application, user].
const asked: string[][] = [];

before(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1" };
  idp = createServer((_, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((r) => idp.listen(0, "127.0.0.1", r));
  const verify = oidcTokenVerifier([
    {
      issuer: ISSUER,
      audience: "riz",
      jwksUri: `http://127.0.0.1:${(idp.address() as AddressInfo).port}/jwks`,
    },
  ]);
  const service = {
    check: async (application: string, user: string) => {
      asked.push([application, user]);
      return { status: "allow" };
    },
  } as unknown as CheckService;
  api = createApp({
    readiness: async () => [],
    log: () => {},
    authenticate: workloadAuthenticator(verify, async () => ["crm-prod"]),
    routes: checkRoutes({
      service,
      verifyEndUser: oidcEndUserVerifier(verify),
      maxBatchSize: 100,
    }),
  });
  await new Promise<void>((r) => api.listen(0, r));
  port = (api.address() as AddressInfo).port;
});

after(() => {
  idp.close();
  api.close();
});

const token = (claims: { azp: string; sub: string }) =>
  new SignJWT({ azp: claims.azp })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(ISSUER)
    .setAudience("riz")
    .setSubject(claims.sub)
    .setExpirationTime("5m")
    .sign(privateKey);

async function check(
  endUserToken: string | undefined,
  extra: { headers?: Record<string, string>; body?: object } = {},
): Promise<{ status: number; code?: string }> {
  const workload = await token({ azp: "crm-service", sub: "svc" });
  const res = await fetch(`http://127.0.0.1:${port}/v1/check`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${workload}`,
      "content-type": "application/json",
      ...(endUserToken ? { "riz-end-user-token": endUserToken } : {}),
      ...extra.headers,
    },
    body: JSON.stringify({
      application: "crm-prod",
      relation: "viewer",
      object: "document:d1",
      ...extra.body,
    }),
  });
  const body = (await res.json()) as { code?: string };
  return { status: res.status, ...(body.code ? { code: body.code } : {}) };
}

test("a delegated token for user U lets the workload check only as U", async () => {
  asked.length = 0;
  const result = await check(await token({ azp: "crm-service", sub: "alice" }));
  assert.equal(result.status, 200);
  assert.deepEqual(asked, [["crm-prod", "alice"]]);
});

test("a user named in a header is ignored and in the body is rejected", async () => {
  asked.length = 0;
  const alice = await token({ azp: "crm-service", sub: "alice" });
  const forgedHeaders = {
    "x-user": "mallory",
    "x-forwarded-user": "mallory",
    "riz-end-user": "mallory",
  };
  assert.equal((await check(alice, { headers: forgedHeaders })).status, 200);
  assert.deepEqual(asked, [["crm-prod", "alice"]]);

  asked.length = 0;
  assert.equal((await check(alice, { body: { user: "mallory" } })).status, 400);
  assert.deepEqual(asked, []);
});

test("a forged identity with no end-user token cannot check", async () => {
  asked.length = 0;
  const result = await check(undefined, { headers: { "x-user": "alice" } });
  assert.equal(result.status, 401);
  assert.equal(result.code, "invalid_end_user_token");
  assert.deepEqual(asked, []);
});

test("a user token issued to another workload is refused", async () => {
  asked.length = 0;
  const result = await check(await token({ azp: "other", sub: "alice" }));
  assert.equal(result.status, 401);
  assert.equal(result.code, "invalid_end_user_token");
  assert.deepEqual(asked, []);
});

test("a user token with no authorized party is refused", async () => {
  const noAzp = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(ISSUER)
    .setAudience("riz")
    .setSubject("alice")
    .setExpirationTime("5m")
    .sign(privateKey);
  assert.equal((await check(noAzp)).status, 401);
});
