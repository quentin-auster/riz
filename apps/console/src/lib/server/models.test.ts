import assert from "node:assert/strict";
import { test } from "node:test";
import { lineDiff } from "./diff.js";
import { rollback } from "./models.js";
import type { Mutator } from "./relationships.js";

const ID = "01HZX3MODEL000000000000000";

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

test("lineDiff marks added, removed and unchanged lines", () => {
  assert.deepEqual(lineDiff("a\nb\nc", "a\nc\nd"), [
    { kind: "same", text: "a" },
    { kind: "del", text: "b" },
    { kind: "same", text: "c" },
    { kind: "add", text: "d" },
  ]);
});

test("rollback without confirmation does not call the API", async () => {
  const mutator: Mutator = async () => {
    throw new Error("must not be called");
  };
  assert.deepEqual(await rollback(mutator, "crm-prod", form({ modelId: ID })), {
    status: 400,
    error: "Rolling back needs confirmation.",
  });
});

test("rollback rejects a malformed model ID without calling the API", async () => {
  const mutator: Mutator = async () => {
    throw new Error("must not be called");
  };
  const result = await rollback(
    mutator,
    "crm-prod",
    form({ modelId: "../x", confirm: "yes" }),
  );
  assert.equal(result.status, 400);
});

test("rollback reports the API's 403 for a caller without models:write", async () => {
  const mutator: Mutator = async () => ({
    ok: false,
    status: 403,
    message: "Missing scope models:write.",
  });
  assert.deepEqual(
    await rollback(mutator, "crm-prod", form({ modelId: ID, confirm: "yes" })),
    { status: 403, error: "Missing scope models:write." },
  );
});

test("a confirmed rollback posts the model and returns the audit id", async () => {
  let sent: unknown;
  const mutator: Mutator = async (path, init) => {
    sent = { path, ...init };
    return { ok: true, auditEventId: "evt-3" };
  };
  const result = await rollback(
    mutator,
    "crm-prod",
    form({ modelId: ID, confirm: "yes" }),
  );
  assert.deepEqual(sent, {
    path: "/v1/models/rollback",
    method: "POST",
    body: { application: "crm-prod", modelId: ID },
  });
  assert.deepEqual(result, {
    status: 200,
    message: "Rolled back.",
    auditEventId: "evt-3",
  });
});
