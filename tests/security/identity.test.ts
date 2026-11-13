import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  ALICE_READS,
  adminStore,
  type Call,
  client,
  fixtureFiles,
  type RunningApi,
  readDoc,
  required,
  startApi,
  startApiExpectingExit,
  unique,
} from "./harness.js";

// Unsafe identity assertions (RIZ-043): every unverified way of claiming an identity is refused,
// against the real API in OIDC mode with a local issuer. Needs RIZ_DATABASE_URL and
// OPENFGA_API_URL. The issuer here is a local test double; real IdPs are unverified.
const ISSUER = "https://idp.example.test";
const AUDIENCE = "riz";
const WORKLOAD = "crm-service";
const PLATFORM = "tok-platform";

let idp: Server;
let oidcApi: RunningApi;
let setupApi: RunningApi;
let call: Call;
let setup: Call;
let dispose: () => void;
let app: string;
let key: CryptoKey;
let attackerKey: CryptoKey;
// Every token the suite presents, so the log check at the end can look for them.
const presented: string[] = [];

before(async () => {
  const pair = await generateKeyPair("RS256");
  key = pair.privateKey;
  attackerKey = (await generateKeyPair("RS256")).privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1" };
  idp = createServer((_, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((r) => idp.listen(0, "127.0.0.1", r));
  const jwksUri = `http://127.0.0.1:${(idp.address() as AddressInfo).port}/jwks`;

  const common = {
    OPENFGA_API_URL: required("OPENFGA_API_URL"),
    RIZ_DATABASE_URL: required("RIZ_DATABASE_URL"),
  };
  // OIDC workloads are granted `check` only, so a fixture-mode API prepares the application.
  const files = fixtureFiles(
    {
      [PLATFORM]: {
        subject: "platform",
        scopes: ["applications:write", "relationships:write", "bindings:write"],
        applications: ["*"],
      },
    },
    {},
  );
  dispose = files.dispose;
  setupApi = await startApi({ ...files.env, ...common });
  setup = client(setupApi.url);
  oidcApi = await startApi({
    ...common,
    ...(await adminStore()),
    NODE_ENV: "development",
    RIZ_AUTH_MODE: "oidc",
    RIZ_OIDC_ISSUERS: JSON.stringify([
      { issuer: ISSUER, audience: AUDIENCE, jwksUri },
    ]),
  });
  call = client(oidcApi.url);

  const name = unique("idn");
  app = `${name}-prod`;
  assert.equal(
    (
      await setup("POST", "/v1/applications", {
        token: PLATFORM,
        body: { name, environment: "prod" },
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await setup("POST", "/v1/relationships", {
        token: PLATFORM,
        body: { application: app, relationships: ALICE_READS },
      })
    ).status,
    204,
  );
  await bind(app);
});

after(async () => {
  await oidcApi?.stop();
  await setupApi?.stop();
  idp?.close();
  dispose?.();
});

const bind = async (application: string) =>
  assert.equal(
    (
      await setup("POST", "/v1/workload-bindings", {
        token: PLATFORM,
        body: { issuer: ISSUER, workload: WORKLOAD, application },
      })
    ).status,
    201,
  );

interface Claims {
  iss?: string;
  aud?: string;
  sub?: string;
  azp?: string | null;
  /** Seconds from now; null omits the claim. */
  exp?: number | null;
  nbf?: number;
}

/** Signs a token; the defaults are valid, and each case breaks exactly one thing. */
async function sign(
  c: Claims = {},
  opts: { signWith?: CryptoKey | Uint8Array; alg?: string } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT(c.azp === null ? {} : { azp: c.azp ?? WORKLOAD })
    .setProtectedHeader({ alg: opts.alg ?? "RS256", kid: "k1" })
    .setIssuer(c.iss ?? ISSUER)
    .setAudience(c.aud ?? AUDIENCE)
    .setSubject(c.sub ?? "svc");
  if (c.exp !== null) jwt.setExpirationTime(now + (c.exp ?? 300));
  if (c.nbf !== undefined) jwt.setNotBefore(now + c.nbf);
  const token = await jwt.sign(opts.signWith ?? key);
  presented.push(token);
  return token;
}

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
/** A token whose header says `alg: none` and which carries no signature. */
function unsigned(claims: object): string {
  const token = `${b64({ alg: "none", typ: "JWT", kid: "k1" })}.${b64(claims)}.`;
  presented.push(token);
  return token;
}
const now = () => Math.floor(Date.now() / 1000);

/** Every way a token can fail verification; each must be refused wherever a token is read. */
const badTokens: [string, () => Promise<string>][] = [
  [
    "alg none",
    async () =>
      unsigned({
        iss: ISSUER,
        aud: AUDIENCE,
        sub: "alice",
        azp: WORKLOAD,
        exp: now() + 300,
      }),
  ],
  [
    "HS256 under a made-up secret",
    () =>
      sign(
        { sub: "alice" },
        {
          alg: "HS256",
          signWith: new TextEncoder().encode(
            "a-secret-that-is-long-enough-for-hs256!!",
          ),
        },
      ),
  ],
  [
    "signed by a key the issuer never published",
    () => sign({ sub: "alice" }, { signWith: attackerKey }),
  ],
  ["wrong audience", () => sign({ sub: "alice", aud: "someone-else" })],
  [
    "wrong issuer",
    () => sign({ sub: "alice", iss: "https://evil.example.test" }),
  ],
  ["expired", () => sign({ sub: "alice", exp: -3600 })],
  ["not valid yet", () => sign({ sub: "alice", nbf: 3600 })],
  ["no expiry", () => sign({ sub: "alice", exp: null })],
  ["not a JWT", async () => "alice"],
];

const check = (
  workloadToken: string | undefined,
  endUserToken: string | undefined,
  extra: { headers?: Record<string, string>; body?: object } = {},
) =>
  call("POST", "/v1/check", {
    ...(workloadToken ? { token: workloadToken } : {}),
    ...(endUserToken ? { user: endUserToken } : {}),
    headers: extra.headers ?? {},
    body: readDoc(app, extra.body ?? {}),
  });

test("a verified workload checking as a verified user it was issued is allowed", async () => {
  const res = await check(await sign(), await sign({ sub: "alice" }));
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "allow");
});

test("a user named in a header or body, or with no end-user token, cannot check", async () => {
  const workload = await sign();
  const forged = {
    "x-user": "alice",
    "x-forwarded-user": "alice",
    "riz-end-user": "alice",
    "x-end-user": "alice",
  };
  const noToken = await check(workload, undefined, { headers: forged });
  assert.equal(noToken.status, 401);
  assert.equal(noToken.body.code, "invalid_end_user_token");

  // With a real token for someone else, a forged header must not change who is checked.
  const bob = await check(workload, await sign({ sub: "bob" }), {
    headers: forged,
  });
  assert.equal(bob.status, 200);
  assert.equal(bob.body.status, "deny");

  const inBody = await check(workload, await sign({ sub: "bob" }), {
    body: { user: "alice" },
  });
  assert.equal(inBody.status, 400);
});

for (const [name, make] of badTokens) {
  test(`a ${name} token is refused as the workload token`, async () => {
    const res = await check(await make(), await sign({ sub: "alice" }));
    assert.equal(res.status, 401);
  });

  test(`a ${name} token is refused as the end-user token`, async () => {
    const res = await check(await sign(), await make());
    assert.equal(res.status, 401);
    assert.equal(res.body.code, "invalid_end_user_token");
  });
}

test("a user token replayed by a workload it was not issued to is refused", async () => {
  const workload = await sign();
  const other = await check(
    workload,
    await sign({ sub: "alice", azp: "other-service" }),
  );
  assert.equal(other.status, 401);
  assert.equal(other.body.code, "invalid_end_user_token");
  const noAzp = await check(workload, await sign({ sub: "alice", azp: null }));
  assert.equal(noAzp.status, 401);
});

test("a valid workload that is not bound to the application is refused", async () => {
  const stranger = await sign({ azp: "unbound-service" });
  const res = await check(
    stranger,
    await sign({ sub: "alice", azp: "unbound-service" }),
  );
  assert.equal(res.status, 403);
});

test("a workload loses access on its next check once it is unbound", async () => {
  const workload = await sign();
  const user = await sign({ sub: "alice" });
  assert.equal((await check(workload, user)).status, 200);

  const unbound = await setup(
    "DELETE",
    `/v1/workload-bindings?issuer=${encodeURIComponent(ISSUER)}&workload=${WORKLOAD}&application=${app}`,
    { token: PLATFORM },
  );
  assert.equal(unbound.status, 204);
  assert.equal((await check(workload, user)).status, 403);

  await bind(app);
  assert.equal((await check(workload, user)).status, 200);
});

test("an OIDC workload cannot use administrative routes with a valid token", async () => {
  const workload = await sign();
  for (const [method, path] of [
    ["POST", "/v1/applications"],
    ["POST", "/v1/relationships"],
    ["POST", "/v1/workload-bindings"],
    ["GET", "/v1/audit"],
  ] as const) {
    const res = await call(method, path, {
      token: workload,
      body: method === "POST" ? {} : undefined,
    });
    assert.equal(res.status, 403, `${method} ${path}`);
  }
});

test("fixture authentication refuses to start in production", async () => {
  const files = fixtureFiles({}, {});
  try {
    const run = await startApiExpectingExit({
      ...files.env,
      NODE_ENV: "production",
      OPENFGA_API_URL: required("OPENFGA_API_URL"),
      RIZ_DATABASE_URL: required("RIZ_DATABASE_URL"),
    });
    assert.notEqual(run.code, 0);
    assert.equal(run.listening, false);
    assert.match(run.output, /must not be used in production/);
  } finally {
    files.dispose();
  }
});

test("the API refuses to start with no authentication mode", async () => {
  const run = await startApiExpectingExit({
    NODE_ENV: "production",
    RIZ_AUTH_MODE: "",
    OPENFGA_API_URL: required("OPENFGA_API_URL"),
    RIZ_DATABASE_URL: required("RIZ_DATABASE_URL"),
  });
  assert.notEqual(run.code, 0);
  assert.equal(run.listening, false);
});

test("no presented token appears in the API's logs", () => {
  assert.ok(presented.length > 10);
  const logs = oidcApi.output();
  for (const token of presented) {
    assert.ok(!logs.includes(token), "a token was logged");
  }
});
