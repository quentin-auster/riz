import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { type ApiError, apiJson } from "./api.js";
import { crossSiteMutation, loginRedirect } from "./guard.js";
import { discover, finishLogin, startLogin } from "./oidc.js";
import { createSessionStore } from "./session.js";

const CLIENT = "riz-console";
const ACCESS_TOKEN = "access-token-secret-value";

/** A minimal OIDC provider that signs real ID tokens and checks PKCE like a real one. */
async function withProvider(
  fn: (ctx: {
    issuer: string;
    config: Parameters<typeof startLogin>[1];
    codeFor: (login: ReturnType<typeof startLogin>) => string;
    mint: (claims?: Record<string, unknown>, kid?: string) => Promise<string>;
    setIdToken: (token: string) => void;
  }) => Promise<void>,
) {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  const other = await generateKeyPair("RS256");
  const challenges = new Map<string, string>();
  let idToken = "";
  let issuer = "";
  const mint = async (claims: Record<string, unknown> = {}, kid = "k1") =>
    new SignJWT({ nonce: "n", ...claims })
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuer(issuer)
      .setAudience(CLIENT)
      .setSubject("anne")
      .setExpirationTime("1h")
      .sign(kid === "k1" ? privateKey : other.privateKey);

  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/.well-known/openid-configuration") {
      return send(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
      });
    }
    if (req.url === "/jwks") return send(200, { keys: [jwk] });
    if (req.url === "/token") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const form = new URLSearchParams(raw);
      const expected = challenges.get(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      if (
        !expected ||
        createHash("sha256").update(verifier).digest("base64url") !== expected
      ) {
        return send(400, { error: "invalid_grant", leak: ACCESS_TOKEN });
      }
      return send(200, { access_token: ACCESS_TOKEN, id_token: idToken });
    }
    send(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn({
      issuer,
      config: {
        issuer,
        clientId: CLIENT,
        redirectUri: "http://localhost:3000/auth/callback",
      },
      codeFor: (started) => {
        const code = `code-${challenges.size}`;
        challenges.set(
          code,
          new URL(started.url).searchParams.get("code_challenge") ?? "",
        );
        return code;
      },
      mint,
      setIdToken: (t) => {
        idToken = t;
      },
    });
  } finally {
    server.close();
  }
}

const callback = (code: string, state: string) =>
  new URLSearchParams({ code, state });

test("login completes with PKCE and keeps the access token out of the result's subject data", async () => {
  await withProvider(async ({ issuer, config, codeFor, mint, setIdToken }) => {
    const meta = await discover(issuer);
    const started = startLogin(meta, config);
    const params = new URL(started.url).searchParams;
    assert.equal(params.get("code_challenge_method"), "S256");
    assert.equal(params.get("state"), started.login.state);

    setIdToken(await mint({ nonce: started.login.nonce }));
    const session = await finishLogin(
      meta,
      config,
      callback(codeFor(started), started.login.state),
      started.login,
    );
    assert.equal(session.subject, "anne");
    assert.equal(session.accessToken, ACCESS_TOKEN);
    assert.ok(session.expiresAt > Date.now());
  });
});

test("a login response that does not match the request is rejected without leaking tokens", async () => {
  await withProvider(async ({ issuer, config, codeFor, mint, setIdToken }) => {
    const meta = await discover(issuer);
    const started = startLogin(meta, config);
    const code = codeFor(started);
    const good = { nonce: started.login.nonce };
    setIdToken(await mint(good));

    const attempts: [string, () => Promise<unknown>][] = [
      [
        "wrong state",
        () => finishLogin(meta, config, callback(code, "other"), started.login),
      ],
      [
        "no saved login",
        () =>
          finishLogin(meta, config, callback(code, started.login.state), null),
      ],
      [
        "wrong PKCE verifier",
        () =>
          finishLogin(meta, config, callback(code, started.login.state), {
            ...started.login,
            verifier: "x".repeat(43),
          }),
      ],
      [
        "wrong nonce",
        async () => {
          setIdToken(await mint({ nonce: "replayed" }));
          return finishLogin(
            meta,
            config,
            callback(code, started.login.state),
            started.login,
          );
        },
      ],
      [
        "ID token signed by another key",
        async () => {
          setIdToken(await mint(good, "k2"));
          return finishLogin(
            meta,
            config,
            callback(code, started.login.state),
            started.login,
          );
        },
      ],
    ];
    for (const [name, attempt] of attempts) {
      await assert.rejects(
        attempt,
        (err: Error) => {
          assert.ok(!err.message.includes(ACCESS_TOKEN), name);
          return true;
        },
        name,
      );
    }
  });
});

test("only the login pages are reachable without a session", () => {
  const session = {
    subject: "a",
    accessToken: "t",
    expiresAt: Date.now() + 1000,
  };
  assert.equal(loginRedirect("/applications", null), "/login");
  assert.equal(loginRedirect("/", null), "/login");
  assert.equal(loginRedirect("/login", null), null);
  assert.equal(loginRedirect("/auth/callback", null), null);
  assert.equal(loginRedirect("/applications", session), null);
});

test("an expired or destroyed session is no session", () => {
  let now = 1000;
  const store = createSessionStore(() => now);
  const id = store.create({ subject: "a", accessToken: "t", expiresAt: 2000 });
  assert.equal(store.get(id)?.subject, "a");
  assert.equal(store.get("guess"), null);
  now = 2000;
  assert.equal(store.get(id), null);
  const again = store.create({
    subject: "a",
    accessToken: "t",
    expiresAt: 9000,
  });
  store.destroy(again);
  assert.equal(store.get(again), null);
});

test("a mutation from another origin is refused, reads are not", () => {
  const own = "https://console.example";
  assert.equal(crossSiteMutation("POST", "https://evil.example", own), true);
  assert.equal(crossSiteMutation("DELETE", null, own), true);
  assert.equal(crossSiteMutation("POST", own, own), false);
  assert.equal(crossSiteMutation("GET", null, own), false);
});

test("the API is called with the user's token and failures keep their status", async () => {
  const seen: { url: string; auth: string | null }[] = [];
  const stub = (async (url: string, init: RequestInit) => {
    seen.push({
      url,
      auth: new Headers(init.headers).get("authorization"),
    });
    return url.endsWith("/forbidden")
      ? new Response(JSON.stringify({ code: "forbidden", message: "no" }), {
          status: 403,
        })
      : new Response(JSON.stringify({ items: [] }), { status: 200 });
  }) as typeof fetch;
  const session = { subject: "a", accessToken: "tok", expiresAt: 1 };

  assert.deepEqual(
    await apiJson("http://api", session, "/v1/applications", {}, stub),
    { items: [] },
  );
  assert.equal(seen[0]?.auth, "Bearer tok");
  await assert.rejects(
    apiJson("http://api", session, "/forbidden", {}, stub),
    (err: ApiError) => err.status === 403 && err.code === "forbidden",
  );
});
