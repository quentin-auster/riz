// Contract tests against a mocked Databricks Statement Execution API. The real Unity
// Catalog test is tests/databricks.test.ts and is UNVERIFIED until run.
import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";
import {
  Databricks,
  DatabricksDeniedError,
  DatabricksError,
  FORWARDED_TOKEN_HEADER,
  MissingUserCredentialError,
  userTokenFromHeaders,
} from "./databricks.js";

const HOST = "dbc-1234.cloud.databricks.com";
const USER_TOKEN = "user-delegated-token";

const OK = {
  statement_id: "st-1",
  status: { state: "SUCCEEDED" },
  manifest: { schema: { columns: [{ name: "id" }, { name: "name" }] } },
  result: {
    data_array: [
      ["1", "anne"],
      ["2", null],
    ],
  },
};

interface Seen {
  url: string;
  init: RequestInit;
}

function mock(respond: () => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return respond();
  }) as unknown as typeof fetch;
  return {
    seen,
    db: new Databricks({
      workspaceHost: HOST,
      warehouseId: "wh1",
      fetch: fetchImpl,
    }),
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });

test("runs the statement as the user and returns rows", async () => {
  const { db, seen } = mock(() => json(200, OK));

  const result = await db.query("SELECT 1", { userToken: USER_TOKEN });

  assert.deepEqual(result.columns, ["id", "name"]);
  assert.deepEqual(result.rows, [
    ["1", "anne"],
    ["2", null],
  ]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.url, `https://${HOST}/api/2.0/sql/statements`);
  const headers = seen[0]?.init.headers as Record<string, string>;
  assert.equal(headers.authorization, `Bearer ${USER_TOKEN}`);
  const sent = JSON.parse(String(seen[0]?.init.body));
  assert.equal(sent.warehouse_id, "wh1");
  assert.equal(sent.statement, "SELECT 1");
  assert.equal(sent.on_wait_timeout, "CANCEL");
});

test("sends named parameters", async () => {
  const { db, seen } = mock(() => json(200, OK));

  await db.query("SELECT 1", {
    userToken: USER_TOKEN,
    parameters: { owner: "anne" },
  });

  assert.deepEqual(JSON.parse(String(seen[0]?.init.body)).parameters, [
    { name: "owner", value: "anne" },
  ]);
});

test("refuses to query without a user token and sends nothing", async () => {
  const { db, seen } = mock(() => json(200, OK));

  for (const userToken of [undefined, ""]) {
    await assert.rejects(
      db.query("SELECT 1", { userToken }),
      MissingUserCredentialError,
    );
  }
  assert.equal(seen.length, 0);
});

test("reads the token databricks apps forwards, whatever the header case", () => {
  assert.equal(
    userTokenFromHeaders({ "X-Forwarded-Access-Token": USER_TOKEN }),
    USER_TOKEN,
  );
  assert.equal(
    userTokenFromHeaders(
      new Headers({ "x-forwarded-access-token": USER_TOKEN }),
    ),
    USER_TOKEN,
  );
});

test("a repeated forwarded header is ambiguous, so it is not used", () => {
  const headers = new Headers();
  headers.append(FORWARDED_TOKEN_HEADER, "a");
  headers.append(FORWARDED_TOKEN_HEADER, "b");

  assert.throws(
    () => userTokenFromHeaders(headers),
    MissingUserCredentialError,
  );
});

test("does not fall back to other headers when the forwarded token is missing", () => {
  for (const headers of [
    {},
    { "x-forwarded-access-token": "" },
    { "x-forwarded-access-token": ["a", "b"] },
    { authorization: "Bearer svc" },
  ]) {
    assert.throws(
      () => userTokenFromHeaders(headers),
      MissingUserCredentialError,
    );
  }
});

test("a user without a unity catalog grant is denied by databricks", async () => {
  const { db } = mock(() =>
    json(200, {
      ...OK,
      status: {
        state: "FAILED",
        error: {
          error_code: "PERMISSION_DENIED",
          message: "no SELECT on main.hr.salaries",
        },
      },
    }),
  );

  const err = await db
    .query("SELECT 1", { userToken: USER_TOKEN })
    .catch((e: unknown) => e);

  assert.ok(err instanceof DatabricksDeniedError);
  assert.equal(err.code, "PERMISSION_DENIED");
});

test("a rejected or expired token is a denial, not an empty result", async () => {
  for (const status of [401, 403]) {
    const { db } = mock(() =>
      json(status, { error_code: "X", message: "nope" }),
    );
    await assert.rejects(
      db.query("SELECT 1", { userToken: USER_TOKEN }),
      DatabricksDeniedError,
    );
  }
});

test("other failures are errors, not denials", async () => {
  const { db } = mock(() => new Response("boom", { status: 500 }));

  const err = await db
    .query("SELECT 1", { userToken: USER_TOKEN })
    .catch((e: unknown) => e);

  assert.ok(err instanceof DatabricksError);
  assert.ok(!(err instanceof DatabricksDeniedError));
  assert.equal(err.status, 500);
});

test("a cancelled statement is an error", async () => {
  const { db } = mock(() =>
    json(200, { ...OK, status: { state: "CANCELED" } }),
  );

  await assert.rejects(
    db.query("SELECT 1", { userToken: USER_TOKEN }),
    DatabricksError,
  );
});

test("a partial result is an error, not a short answer", async () => {
  const { db } = mock(() =>
    json(200, {
      ...OK,
      result: { data_array: [["1", "anne"]], next_chunk_index: 1 },
    }),
  );

  const err = await db
    .query("SELECT 1", { userToken: USER_TOKEN })
    .catch((e: unknown) => e);

  assert.ok(err instanceof DatabricksError);
  assert.equal(err.code, "result_too_large");
});

test("the token does not follow a redirect", async () => {
  const { db, seen } = mock(
    () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.example.com/steal" },
      }),
  );

  await assert.rejects(
    db.query("SELECT 1", { userToken: USER_TOKEN }),
    DatabricksError,
  );

  assert.equal(seen.length, 1);
  assert.equal((seen[0]?.init as { redirect?: string }).redirect, "manual");
});

test("rejects a workspace host that could receive the token elsewhere", () => {
  for (const workspaceHost of [
    `https://${HOST}`,
    `${HOST}/path`,
    `${HOST}:8443`,
    `user:pw@${HOST}`,
    "localhost",
    "EVIL.example.com",
    "",
  ]) {
    assert.throws(
      () => new Databricks({ workspaceHost, warehouseId: "wh1" }),
      TypeError,
      workspaceHost,
    );
  }
});

test("a transport failure does not carry the user token", async () => {
  const { db } = mock(() => {
    throw new TypeError(`failed with Bearer ${USER_TOKEN}`, {
      cause: new Error(USER_TOKEN),
    });
  });

  const err = await db
    .query("SELECT 1", { userToken: USER_TOKEN })
    .catch((e: unknown) => e);

  assert.ok(err instanceof DatabricksError);
  assert.ok(!inspect(err, { depth: 10 }).includes(USER_TOKEN));
});
