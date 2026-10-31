import assert from "node:assert/strict";
import { test } from "node:test";
import { auditQuery } from "./audit.js";

test("auditQuery sends only the filters that were filled in, with UTC times and the cursor", () => {
  const q = auditQuery(
    new URLSearchParams({
      application: "crm-prod",
      actor: "",
      action: "models.rollback",
      from: "2026-01-02T03:04",
      cursor: "abc",
    }),
  );
  assert.ok(!("error" in q));
  assert.equal(
    q.query.toString(),
    "limit=50&application=crm-prod&action=models.rollback&from=2026-01-02T03%3A04%3A00.000Z&cursor=abc",
  );
  assert.equal(q.filters.actor, "");
});

test("auditQuery reports a bad date instead of calling the API", () => {
  assert.deepEqual(auditQuery(new URLSearchParams({ to: "tomorrow-ish" })), {
    error: "to is not a valid date and time.",
  });
});
