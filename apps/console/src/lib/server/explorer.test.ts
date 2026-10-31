import assert from "node:assert/strict";
import { test } from "node:test";
import { explore, type Poster } from "./explorer.js";

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

const query = {
  application: "crm-prod",
  principal: "anne",
  relation: "read",
  object: "document:d1",
};

test("explore returns the API's decision, model and request id", async () => {
  let sent: unknown;
  const post: Poster = async (path, init) => {
    sent = { path, ...init };
    return {
      ok: true,
      body: { status: "allow", modelId: "m1", requestId: "req_1" },
    };
  };
  const result = await explore(post, form(query));
  assert.deepEqual(sent, {
    path: "/v1/explorer/check",
    method: "POST",
    body: query,
  });
  assert.deepEqual(result, {
    status: 200,
    answer: { status: "allow", modelId: "m1", requestId: "req_1" },
  });
});

test("explore reports the API's 403 for a caller without the explorer scope", async () => {
  const post: Poster = async () => ({
    ok: false,
    status: 403,
    message: "Missing scope explorer:check.",
  });
  assert.deepEqual(await explore(post, form(query)), {
    status: 403,
    error: "Missing scope explorer:check.",
  });
});

test("explore rejects a malformed query without calling the API", async () => {
  const post: Poster = async () => {
    throw new Error("must not be called");
  };
  for (const bad of [
    { ...query, principal: "anne#member" },
    { ...query, object: "document" },
    { ...query, relation: "" },
    { ...query, application: "CRM" },
  ]) {
    assert.equal((await explore(post, form(bad))).status, 400);
  }
});
