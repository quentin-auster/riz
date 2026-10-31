import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import { oidcTokenVerifier, type TokenVerifier } from "./oidc.js";

const ISSUER = "https://idp.example.test";
const AUDIENCE = "riz";

let server: Server;
let verify: TokenVerifier;
let privateKey: CryptoKey;
let publicJwk: JWK;

before(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" };
  server = createServer((_, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: [publicJwk] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  verify = oidcTokenVerifier([
    {
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUri: `http://127.0.0.1:${port}/jwks`,
    },
  ]);
});

after(() => {
  server.close();
});

function sign(
  overrides: {
    iss?: string;
    aud?: string;
    exp?: string | number;
    nbf?: number;
    kid?: string;
  } = {},
  key: CryptoKey = privateKey,
): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: overrides.kid ?? "k1" })
    .setIssuer(overrides.iss ?? ISSUER)
    .setAudience(overrides.aud ?? AUDIENCE)
    .setSubject("workload-a")
    .setExpirationTime(overrides.exp ?? "5m")
    .sign(key);
}

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");

test("accepts a valid token and returns its issuer and subject", async () => {
  const verified = await verify(await sign());
  assert.equal(verified?.issuer, ISSUER);
  assert.equal(verified?.subject, "workload-a");
});

test("rejects an expired token", async () => {
  const past = Math.floor(Date.now() / 1000) - 3600;
  assert.equal(await verify(await sign({ exp: past })), null);
});

test("rejects a token that is not valid yet", async () => {
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject("workload-a")
    .setNotBefore(Math.floor(Date.now() / 1000) + 3600)
    .setExpirationTime("2h")
    .sign(privateKey);
  assert.equal(await verify(token), null);
});

test("rejects a token for another audience", async () => {
  assert.equal(await verify(await sign({ aud: "someone-else" })), null);
});

test("rejects a token from an issuer that is not configured", async () => {
  assert.equal(
    await verify(await sign({ iss: "https://evil.example.test" })),
    null,
  );
});

test("rejects alg none", async () => {
  const claims = {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: "workload-a",
    exp: Math.floor(Date.now() / 1000) + 300,
  };
  assert.equal(
    await verify(`${b64({ alg: "none", typ: "JWT" })}.${b64(claims)}.`),
    null,
  );
});

test("rejects an HS256 token signed with the public key as the secret", async () => {
  const claims = {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: "workload-a",
    exp: Math.floor(Date.now() / 1000) + 300,
  };
  const { createHmac } = await import("node:crypto");
  const head = b64({ alg: "HS256", kid: "k1" });
  const body = b64(claims);
  const sig = createHmac("sha256", JSON.stringify(publicJwk))
    .update(`${head}.${body}`)
    .digest("base64url");
  assert.equal(await verify(`${head}.${body}.${sig}`), null);
});

test("rejects a token whose kid is not in the key set", async () => {
  assert.equal(await verify(await sign({ kid: "unknown" })), null);
});

test("rejects a token signed by a different key under a known kid", async () => {
  const other = await generateKeyPair("RS256");
  assert.equal(await verify(await sign({}, other.privateKey)), null);
});

test("rejects a token with a tampered payload", async () => {
  const [head, , sig] = (await sign()).split(".");
  const forged = b64({
    iss: ISSUER,
    aud: AUDIENCE,
    sub: "admin",
    exp: Math.floor(Date.now() / 1000) + 300,
  });
  assert.equal(await verify(`${head}.${forged}.${sig}`), null);
});

test("rejects a token with no expiry", async () => {
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject("workload-a")
    .sign(privateKey);
  assert.equal(await verify(token), null);
});

test("rejects garbage that is not a JWT", async () => {
  assert.equal(await verify("not-a-jwt"), null);
});

test("throws, rather than reporting an invalid token, when the key set is unreachable", async () => {
  const down = oidcTokenVerifier([
    { issuer: ISSUER, audience: AUDIENCE, jwksUri: "http://127.0.0.1:9/jwks" },
  ]);
  await assert.rejects(down(await sign()));
});

test("refuses configuration with a symmetric algorithm or a plain-http remote key set", () => {
  const base = {
    issuer: ISSUER,
    audience: AUDIENCE,
    jwksUri: "https://idp.example.test/jwks",
  };
  assert.throws(
    () => oidcTokenVerifier([{ ...base, algorithms: ["HS256"] }]),
    /asymmetric/,
  );
  assert.throws(
    () =>
      oidcTokenVerifier([{ ...base, jwksUri: "http://idp.example.test/jwks" }]),
    /https/,
  );
});
