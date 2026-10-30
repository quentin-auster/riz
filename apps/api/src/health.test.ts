import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import pg from "pg";
import { readiness } from "./health.js";

// "Stopped" dependencies are simulated by refused connections and by listeners that never answer.
const REFUSED = "http://127.0.0.1:1";
const deadPool = () =>
  new pg.Pool({ connectionString: "postgres://x:x@127.0.0.1:1/x" });

const url = process.env.RIZ_DATABASE_URL;
const apiUrl = process.env.OPENFGA_API_URL;

test("reports both dependencies down when neither is reachable", async () => {
  const pool = deadPool();
  try {
    const down = await readiness({
      pool,
      openfgaUrl: REFUSED,
      timeoutMs: 500,
    })();
    assert.deepEqual(down, ["openfga", "postgres"]);
  } finally {
    await pool.end();
  }
});

test("reports OpenFGA down within the timeout when it hangs", async () => {
  const hang = createServer(() => {});
  await new Promise<void>((resolve) => hang.listen(0, resolve));
  const pool = deadPool();
  try {
    const started = Date.now();
    const down = await readiness({
      pool,
      openfgaUrl: `http://127.0.0.1:${(hang.address() as AddressInfo).port}`,
      timeoutMs: 300,
    })();
    assert.ok(down.includes("openfga"));
    assert.ok(Date.now() - started < 1500, "answered well past the timeout");
  } finally {
    hang.closeAllConnections();
    hang.close();
    await pool.end();
  }
});

// Integration: needs Postgres and OpenFGA. Unverified until run against both.
const opts = {
  skip: url && apiUrl ? false : "RIZ_DATABASE_URL and OPENFGA_API_URL not set",
};

test(
  "is ready when Postgres and OpenFGA are up, and names only the one that is down",
  opts,
  async () => {
    const pool = new pg.Pool({ connectionString: url });
    try {
      assert.deepEqual(
        await readiness({
          pool,
          openfgaUrl: apiUrl as string,
          timeoutMs: 2000,
        })(),
        [],
      );
      assert.deepEqual(
        await readiness({ pool, openfgaUrl: REFUSED, timeoutMs: 2000 })(),
        ["openfga"],
      );
    } finally {
      await pool.end();
    }
    const dead = deadPool();
    try {
      assert.deepEqual(
        await readiness({
          pool: dead,
          openfgaUrl: apiUrl as string,
          timeoutMs: 2000,
        })(),
        ["postgres"],
      );
    } finally {
      await dead.end();
    }
  },
);
