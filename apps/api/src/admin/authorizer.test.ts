import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { OpenFgaClient } from "@openfga/sdk";
import { transformer } from "@openfga/syntax-transformer";
import { createAdminAuthorizer } from "./authorizer.js";

// Integration: needs OpenFGA. Unverified until run against one.
const apiUrl = process.env.OPENFGA_API_URL;
const opts = { skip: apiUrl ? false : "OPENFGA_API_URL not set" };

async function adminStore() {
  const url = apiUrl as string;
  const { id: storeId } = await new OpenFgaClient({ apiUrl: url }).createStore({
    name: "riz-admin-test",
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
  await new OpenFgaClient({
    apiUrl: url,
    storeId,
    authorizationModelId: modelId,
  }).write({
    writes: [
      { user: "user:olga", relation: "security_admin", object: org },
      { user: "user:audrey", relation: "auditor", object: org },
      { user: org, relation: "organization", object: "application:a-prod" },
      { user: org, relation: "organization", object: "application:b-prod" },
      { user: "user:alice", relation: "admin", object: "application:a-prod" },
    ],
  });
  return createAdminAuthorizer({ apiUrl: url, storeId, modelId });
}

test("an application admin for A cannot mutate B", opts, async () => {
  const authz = await adminStore();
  assert.equal(
    await authz.application("alice", "can_manage_model", "a-prod"),
    true,
  );
  for (const relation of [
    "can_read",
    "can_manage_relationships",
    "can_manage_model",
    "can_read_audit",
  ] as const) {
    assert.equal(await authz.application("alice", relation, "b-prod"), false);
  }
  assert.equal(
    await authz.organization("alice", "can_register_application"),
    false,
  );
  assert.deepEqual(await authz.readableApplications("alice"), ["a-prod"]);
});

test("an auditor can read audit but not mutate", opts, async () => {
  const authz = await adminStore();
  assert.equal(await authz.organization("audrey", "can_read_audit"), true);
  assert.equal(
    await authz.application("audrey", "can_read_audit", "b-prod"),
    true,
  );
  assert.equal(
    await authz.organization("audrey", "can_register_application"),
    false,
  );
  assert.equal(
    await authz.organization("audrey", "can_manage_bindings"),
    false,
  );
  assert.equal(
    await authz.application("audrey", "can_manage_relationships", "a-prod"),
    false,
  );
  assert.equal(
    await authz.application("audrey", "can_manage_model", "a-prod"),
    false,
  );
});

test(
  "a security admin administers everything; an unknown subject nothing",
  opts,
  async () => {
    const authz = await adminStore();
    assert.equal(
      await authz.organization("olga", "can_register_application"),
      true,
    );
    assert.equal(
      await authz.application("olga", "can_manage_model", "b-prod"),
      true,
    );
    assert.equal(await authz.organization("mallory", "can_read_audit"), false);
    assert.deepEqual(await authz.readableApplications("mallory"), []);
  },
);

test(
  "a subject that could name another object is denied, not escaped",
  opts,
  async () => {
    const authz = await adminStore();
    assert.equal(
      await authz.organization("olga#x", "can_register_application"),
      false,
    );
    assert.equal(
      await authz.organization("user:olga", "can_register_application"),
      false,
    );
    assert.equal(
      await authz.application("alice", "can_read", "a-prod#admin"),
      false,
    );
    assert.deepEqual(await authz.readableApplications("a|b"), []);
  },
);

test("an unreachable OpenFGA is a 503, never an allow", async () => {
  const authz = createAdminAuthorizer({
    apiUrl: "http://127.0.0.1:1",
    storeId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    modelId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  });
  await assert.rejects(() => authz.organization("olga", "can_read_audit"), {
    status: 503,
    code: "authorization_unavailable",
  });
  await assert.rejects(() => authz.readableApplications("olga"), {
    status: 503,
  });
});
