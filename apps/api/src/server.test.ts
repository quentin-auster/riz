import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Principal } from "./auth/index.js";
import { createApp } from "./server.js";

const anne: Principal = { subject: "anne", scopes: [], applications: [] };
const authenticate = (authorization: string | undefined) =>
  authorization === "Bearer good" ? anne : null;

async function get(path: string, authorization?: string): Promise<Response> {
  const server = createApp({ authenticate, routes: async () => false });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const { port } = server.address() as AddressInfo;
    return await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: authorization ? { authorization } : {},
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
