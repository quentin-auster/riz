import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { drain } from "./shutdown.js";

async function listen(handler: Parameters<typeof createServer>[1]) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}

test("an in-flight request completes after draining starts, without waiting for the keep-alive timeout", async () => {
  const { server, base } = await listen((_req, res) => {
    setTimeout(() => res.end("done"), 200);
  });
  const inFlight = fetch(base);
  await new Promise((r) => setTimeout(r, 50));
  const started = Date.now();
  const drained = drain(server, 10_000);

  const res = await inFlight;
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "done");
  await drained;
  // Node's keep-alive timeout is 5s; draining must not wait for it.
  assert.ok(Date.now() - started < 2000, "drain waited on an idle connection");
  await assert.rejects(fetch(base));
});

test("a request still running at the deadline is cut so draining finishes", async () => {
  const { server, base } = await listen(() => {});
  const stuck = fetch(base).catch((err) => err);
  await new Promise((r) => setTimeout(r, 50));

  const started = Date.now();
  await drain(server, 200);

  assert.ok(Date.now() - started < 2000, "drain outlived its deadline");
  assert.ok((await stuck) instanceof Error);
});
