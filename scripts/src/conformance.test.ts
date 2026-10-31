import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { conformanceProblems } from "./conformance.js";

const root = resolve(import.meta.dirname, "../..");
const spec = join(root, "contracts/openapi.yaml");

const allow = { status: "allow", requestId: "req_1" };

function casesDir(c: object): string {
  const dir = mkdtempSync(join(tmpdir(), "riz-cases-"));
  writeFileSync(join(dir, "case.json"), JSON.stringify(c));
  return dir;
}

const base = {
  call: { operation: "check" },
  expectRequest: {
    method: "POST",
    path: "/v1/check",
    body: { application: "crm", relation: "read", object: "document:d1" },
  },
  response: { status: 200, body: allow },
  expect: { result: { allowed: true } },
};

test("every SDK conformance case conforms to the OpenAPI contract", () => {
  assert.deepEqual(
    conformanceProblems(join(root, "tests/conformance/cases"), spec),
    [],
  );
});

test("accepts a case that conforms", () => {
  assert.deepEqual(conformanceProblems(casesDir(base), spec), []);
});

test("rejects a response that violates the contract", () => {
  const bad = { ...base, response: { status: 200, body: { status: "allow" } } };
  assert.match(
    conformanceProblems(casesDir(bad), spec).join(),
    /does not conform/,
  );
});

test("rejects a request body the contract would refuse", () => {
  const bad = {
    ...base,
    expectRequest: { ...base.expectRequest, body: { relation: "read" } },
  };
  assert.match(
    conformanceProblems(casesDir(bad), spec).join(),
    /request body does not conform/,
  );
});

test("rejects a nonconforming flag on a response that conforms", () => {
  const bad = { ...base, nonconformingResponse: true };
  assert.match(
    conformanceProblems(casesDir(bad), spec).join(),
    /remove nonconformingResponse/,
  );
});
