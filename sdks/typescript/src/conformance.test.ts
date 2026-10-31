import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { type Consistency, Riz } from "./index.js";

// Runs the shared cases in tests/conformance; see its README for the format.
const casesDir = join(import.meta.dirname, "../../../tests/conformance/cases");
const BEARER = "svc-token";

type Json = Record<string, unknown>;
type Case = {
  name: string;
  client?: { timeoutMs: number };
  call: {
    operation: "check" | "batchCheck";
    endUserToken: string;
    consistency?: Consistency;
    action?: string;
    resource?: string;
    checks?: { action: string; resource: string; count?: number }[];
  };
  expectRequest: { method: string; path: string; body?: unknown };
  response: {
    status?: number;
    headers?: Record<string, string>;
    body?: unknown;
    delayMs?: number;
    drop?: boolean;
  };
  expect: { result?: unknown; error?: Json };
};

/** Every key in `expected` must match; extra keys in `actual` are ignored. */
function assertSubset(actual: unknown, expected: unknown, at = "result") {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${at} is an array`);
    assert.equal(actual.length, expected.length, `${at} length`);
    expected.forEach((e, i) => {
      assertSubset(actual[i], e, `${at}[${i}]`);
    });
  } else if (typeof expected === "object" && expected !== null) {
    assert.ok(typeof actual === "object" && actual !== null, `${at} is set`);
    for (const [k, v] of Object.entries(expected)) {
      assertSubset((actual as Json)[k], v, `${at}.${k}`);
    }
  } else {
    assert.equal(actual, expected, at);
  }
}

async function run(c: Case) {
  const received: {
    method: string | undefined;
    url: string | undefined;
    headers: Json;
    body: string;
  }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    received.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks).toString(),
    });
    const r = c.response;
    if (r.drop) {
      req.socket.destroy();
      return;
    }
    const timer = setTimeout(() => {
      res.writeHead(r.status ?? 200, {
        "content-type": "application/json",
        ...r.headers,
      });
      res.end(typeof r.body === "string" ? r.body : JSON.stringify(r.body));
    }, r.delayMs ?? 0);
    res.on("close", () => clearTimeout(timer));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const riz = new Riz({
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      credentials: BEARER,
      application: "crm",
      timeoutMs: c.client?.timeoutMs ?? 2000,
    });
    const { call } = c;
    let result: unknown;
    let error: unknown;
    try {
      result =
        call.operation === "check"
          ? await riz.check({
              action: call.action as string,
              resource: call.resource as string,
              endUserToken: call.endUserToken,
              ...(call.consistency && { consistency: call.consistency }),
            })
          : await riz.batchCheck(
              (call.checks ?? []).flatMap(({ count = 1, ...check }) =>
                Array.from({ length: count }, () => check),
              ),
              {
                endUserToken: call.endUserToken,
                ...(call.consistency && { consistency: call.consistency }),
              },
            );
    } catch (e) {
      error = e;
    }

    assert.equal(received.length, 1, "exactly one request reaches riz");
    const [req] = received;
    assert.equal(req?.method, c.expectRequest.method);
    assert.equal(req?.url, c.expectRequest.path);
    assert.equal(req?.headers.authorization, `Bearer ${BEARER}`);
    assert.equal(req?.headers["riz-end-user-token"], call.endUserToken);
    assert.match(String(req?.headers["content-type"]), /^application\/json/);
    if (c.expectRequest.body !== undefined) {
      assert.deepEqual(JSON.parse(req?.body ?? ""), c.expectRequest.body);
    }

    if (c.expect.error) {
      assert.ok(error instanceof Error, `expected ${c.expect.error.type}`);
      const { type, ...fields } = c.expect.error;
      assert.equal(error.constructor.name, type);
      assertSubset(error, fields, "error");
      for (const token of [BEARER, call.endUserToken]) {
        assert.ok(!error.message.includes(token), "error leaks a token");
      }
    } else {
      if (error) throw error;
      assertSubset(result, c.expect.result);
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

for (const file of readdirSync(casesDir).filter((f) => f.endsWith(".json"))) {
  const c = JSON.parse(readFileSync(join(casesDir, file), "utf8")) as Case;
  test(c.name, () => run(c));
}
