import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mock, test } from "node:test";
import type { Principal } from "./auth/index.js";
import { redact } from "./logging.js";
import { createApp } from "./server.js";

const anne: Principal = { subject: "anne", scopes: [], applications: [] };
const authenticate = (authorization: string | undefined) =>
  authorization === "Bearer good" ? anne : null;

async function get(
  path: string,
  authorization?: string,
  opts: {
    readiness?: () => Promise<string[]>;
    routes?: () => Promise<boolean>;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const server = createApp({
    authenticate,
    routes: opts.routes ?? (async () => false),
    readiness: opts.readiness ?? (async () => []),
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const { port } = server.address() as AddressInfo;
    return await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: { ...(authorization ? { authorization } : {}), ...opts.headers },
    });
  } finally {
    server.close();
  }
}

test("liveness returns 200 ok without credentials", async () => {
  const res = await get("/health/live");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok" });
});

test("readiness returns 200 when dependencies are up and 503 when any is down", async () => {
  assert.equal((await get("/health/ready")).status, 200);
  for (const down of [["openfga"], ["postgres"], ["openfga", "postgres"]]) {
    const res = await get("/health/ready", undefined, {
      readiness: async () => down,
    });
    assert.equal(res.status, 503, down.join());
    assert.equal(((await res.json()) as { code: string }).code, "not_ready");
  }
});

test("unknown route returns 404", async () => {
  const res = await get("/nope");
  assert.equal(res.status, 404);
});

test("v1 routes return 401 without a valid bearer token", async () => {
  for (const [path, auth] of [
    ["/v1/applications", undefined],
    ["/v1/does-not-exist", undefined],
    ["/v1/applications", "Bearer bad"],
    ["/v1/applications", "Basic good"],
  ] as const) {
    const res = await get(path, auth);
    assert.equal(res.status, 401, `${path} with ${auth}`);
    assert.equal(
      ((await res.json()) as { code: string }).code,
      "unauthenticated",
    );
  }
});

test("v1 routes let an authenticated caller through", async () => {
  const res = await get("/v1/does-not-exist", "Bearer good");
  assert.equal(res.status, 404);
});

test("a caller-supplied request ID is echoed in the header and error body", async () => {
  const res = await get("/nope", undefined, {
    headers: { "x-request-id": "trace-123" },
  });
  assert.equal(res.headers.get("x-request-id"), "trace-123");
  assert.equal(
    ((await res.json()) as { requestId: string }).requestId,
    "trace-123",
  );
});

test("a malformed request ID is replaced rather than echoed", async () => {
  const res = await get("/nope", undefined, {
    headers: { "x-request-id": "bad id\twith spaces" },
  });
  assert.match(res.headers.get("x-request-id") ?? "", /^req_[0-9a-f-]{36}$/);
});

test("a bearer token never appears in log output", async () => {
  const secret = "s3cret-bearer-value";
  const out = mock.method(console, "log", () => {});
  try {
    await get("/health/ready", `Bearer ${secret}`, {
      readiness: async () => ["openfga"],
    });
    await get("/v1/applications", `Bearer ${secret}`);
    await get(`/v1/applications?cursor=Bearer%20${secret}`, "Bearer good", {
      routes: async () => {
        throw new Error(`boom Bearer ${secret}`);
      },
    });
    const logged = out.mock.calls.map((c) => String(c.arguments[0])).join("\n");
    assert.match(logged, /"msg":"request"/);
    assert.match(logged, /"msg":"unhandled error"/);
    assert.equal(logged.includes(secret), false);
  } finally {
    out.mock.restore();
  }
});

test("redact masks credential keys and bearer text at any depth", () => {
  assert.deepEqual(
    redact({
      authorization: "Bearer abc",
      nested: { endUserToken: "t", note: "sent Bearer abc.def here", ok: 1 },
      list: [{ password: "p" }],
    }),
    {
      authorization: "[redacted]",
      nested: {
        endUserToken: "[redacted]",
        note: "sent Bearer [redacted] here",
        ok: 1,
      },
      list: [{ password: "[redacted]" }],
    },
  );
});
