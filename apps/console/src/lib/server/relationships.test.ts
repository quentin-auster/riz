import assert from "node:assert/strict";
import { test } from "node:test";
import { apiMutation } from "./api.js";
import { grant, type Mutator, revoke } from "./relationships.js";

const session = { accessToken: "t" } as never;

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

const tuple = { subject: "user:anne", relation: "member", object: "team:eng" };

test("apiMutation returns the audit event id the API put in the header", async () => {
  const fetchImpl = (async () =>
    new Response(null, {
      status: 204,
      headers: { "riz-audit-event-id": "evt-1" },
    })) as typeof fetch;
  const result = await apiMutation(
    "http://api",
    session,
    "/v1/relationships",
    { method: "POST", body: {} },
    fetchImpl,
  );
  assert.deepEqual(result, { auditEventId: "evt-1", body: undefined });
});

test("apiMutation throws the API's refusal when a non-admin is forbidden", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ code: "forbidden", message: "no scope" }), {
      status: 403,
    })) as typeof fetch;
  await assert.rejects(
    apiMutation(
      "http://api",
      session,
      "/v1/relationships",
      { method: "POST", body: {} },
      fetchImpl,
    ),
    { status: 403, message: "no scope" },
  );
});

test("grant reports the API's 403 instead of treating the change as done", async () => {
  const mutator: Mutator = async () => ({
    ok: false,
    status: 403,
    message: "no scope",
  });
  assert.deepEqual(await grant(mutator, "crm", form(tuple)), {
    status: 403,
    error: "no scope",
  });
});

test("grant sends the tuple for the application and returns the audit id", async () => {
  let sent: unknown;
  const mutator: Mutator = async (path, init) => {
    sent = { path, ...init };
    return { ok: true, auditEventId: "evt-2" };
  };
  const result = await grant(mutator, "crm", form(tuple));
  assert.deepEqual(sent, {
    path: "/v1/relationships",
    method: "POST",
    body: { application: "crm", relationships: [tuple] },
  });
  assert.deepEqual(result, {
    status: 200,
    message: "Relationship granted.",
    auditEventId: "evt-2",
  });
});

test("grant rejects a malformed subject without calling the API", async () => {
  const mutator: Mutator = async () => {
    throw new Error("must not be called");
  };
  const result = await grant(
    mutator,
    "crm",
    form({ ...tuple, subject: "anne" }),
  );
  assert.equal(result.status, 400);
});

test("revoke without confirmation does not call the API", async () => {
  const mutator: Mutator = async () => {
    throw new Error("must not be called");
  };
  const result = await revoke(mutator, "crm", form(tuple));
  assert.deepEqual(result, {
    status: 400,
    error: "Revoking needs confirmation.",
  });
});

test("revoke deletes the tuple once confirmed, and reports a 403", async () => {
  let sent: unknown;
  const mutator: Mutator = async (path, init) => {
    sent = { path, ...init };
    return { ok: false, status: 403, message: "no scope" };
  };
  const result = await revoke(
    mutator,
    "crm",
    form({ ...tuple, confirm: "yes" }),
  );
  assert.deepEqual(sent, {
    path: "/v1/relationships?application=crm&subject=user%3Aanne&relation=member&object=team%3Aeng",
    method: "DELETE",
  });
  assert.deepEqual(result, { status: 403, error: "no scope" });
});
