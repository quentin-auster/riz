import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApp } from "./server.js";

async function get(path: string): Promise<Response> {
  const server = createApp();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const { port } = server.address() as AddressInfo;
    return await fetch(`http://127.0.0.1:${port}${path}`);
  } finally {
    server.close();
  }
}

test("liveness returns 200 ok", async () => {
  const res = await get("/health/live");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok" });
});

test("unknown route returns 404", async () => {
  const res = await get("/nope");
  assert.equal(res.status, 404);
});
