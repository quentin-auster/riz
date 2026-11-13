import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { OpenFgaClient } from "@openfga/sdk";
import { transformer } from "@openfga/syntax-transformer";
import type { Principal } from "../auth/index.js";
import { createAdminAuthorizer } from "./authorizer.js";
import { adminSubject, withAdminScopes } from "./elevate.js";

// Integration: needs OpenFGA. Unverified until run against one.
const apiUrl = process.env.OPENFGA_API_URL;
const opts = { skip: apiUrl ? false : "OPENFGA_API_URL not set" };

const workload = (name: string): Principal => ({
  subject: `https://idp.example.test|${name}`,
  scopes: ["check"],
  applications: ["crm-prod"],
  clientId: name,
  issuer: "https://idp.example.test",
});

async function elevator() {
  const url = apiUrl as string;
  const { id: storeId } = await new OpenFgaClient({ apiUrl: url }).createStore({
    name: "riz-admin-elevate-test",
  });
  const { authorization_model_id: modelId } = await new OpenFgaClient({
    apiUrl: url,
    storeId,
  }).writeAuthorizationModel(
    transformer.transformDSLToJSONObject(
      readFileSync(
        join(import.meta.dirname, "../../../../models/openfga/riz-admin.fga"),
        "utf8",
      ),
    ),
  );
  assert.ok(modelId);
  const org = "organization:default";
  const user = (name: string) =>
    `user:${adminSubject("https://idp.example.test", name)}`;
  await new OpenFgaClient({
    apiUrl: url,
    storeId,
    authorizationModelId: modelId,
  }).write({
    writes: [
      { user: user("ops"), relation: "security_admin", object: org },
      { user: user("auditor"), relation: "auditor", object: org },
      { user: org, relation: "organization", object: "application:crm-prod" },
      {
        user: user("crm-admin"),
        relation: "admin",
        object: "application:crm-prod",
      },
    ],
  });
  return withAdminScopes(
    createAdminAuthorizer({ apiUrl: url, storeId, modelId }),
  );
}

test("names a workload by the hash of its issuer and client ID", () => {
  // The same vector is pinned in scripts/src/bootstrap.test.ts; change both together.
  assert.equal(
    adminSubject("https://idp.example.test", "ops"),
    "159a4a0e1c6bdd49744b2d63187091850cc5e70d1e6cb0618d0c93e2a85906f2",
  );
});

test("a separator inside the issuer or client ID cannot make two workloads collide", () => {
  assert.notEqual(adminSubject("a|b", "c"), adminSubject("a", "b|c"));
});

test(
  "a security admin workload gets every admin scope on all applications",
  opts,
  async () => {
    const elevate = await elevator();
    const p = await elevate(workload("ops"));
    for (const scope of [
      "check",
      "applications:write",
      "bindings:write",
      "models:write",
      "relationships:write",
      "audit:read",
    ]) {
      assert.ok(p.scopes.includes(scope), scope);
    }
    assert.deepEqual(p.applications, ["*"]);
  },
);

test("an auditor workload can read but not write", opts, async () => {
  const elevate = await elevator();
  const p = await elevate(workload("auditor"));
  assert.ok(p.scopes.includes("applications:read"));
  assert.ok(p.scopes.includes("audit:read"));
  assert.ok(!p.scopes.some((s) => s.endsWith(":write")));
  assert.ok(!p.scopes.includes("relationships:read"));
});

test(
  "a workload with no organization role, or only an application role, stays check-only",
  opts,
  async () => {
    const elevate = await elevator();
    for (const name of ["crm-admin", "stranger"]) {
      assert.deepEqual(await elevate(workload(name)), workload(name));
    }
  },
);

test(
  "a different issuer with the same client ID is not the same admin",
  opts,
  async () => {
    const elevate = await elevator();
    const impostor = {
      ...workload("ops"),
      subject: "https://evil.example.test|ops",
      issuer: "https://evil.example.test",
    };
    assert.deepEqual(await elevate(impostor), impostor);
  },
);

test("an unreachable admin store is a 503, never an allow", async () => {
  const elevate = withAdminScopes(
    createAdminAuthorizer({
      apiUrl: "http://127.0.0.1:1",
      storeId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      modelId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    }),
  );
  await assert.rejects(() => elevate(workload("ops")), { status: 503 });
});
