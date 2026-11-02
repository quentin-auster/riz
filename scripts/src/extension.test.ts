import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { OpenFgaClient } from "@openfga/sdk";
import { validateExtension, writeExtension } from "./extension.js";

const modelsDir = resolve(import.meta.dirname, "../../models/openfga");

function extensionDir(extension: string, tests?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "riz-ext-"));
  writeFileSync(join(dir, "extension.fga"), extension);
  writeFileSync(
    join(dir, "extension.tests.yaml"),
    tests ??
      `name: t
model_file: ./extension.fga
tests:
  - name: owner
    check:
      - user: user:olga
        object: folder:f1
        assertions: { owner: false }
`,
  );
  return join(dir, "extension.fga");
}

test("accepts the crm extension on top of the core model", () => {
  validateExtension(join(modelsDir, "apps/crm/extension.fga"));
});

test("rejects an extension that redeclares a core type", () => {
  const file = extensionDir(`type organization
  relations
    define admin: [user]
`);
  assert.throws(
    () => validateExtension(file),
    /redeclares a type: organization/,
  );
});

for (const coreType of ["user", "application"]) {
  test(`rejects an extension that redeclares the core ${coreType} type`, () => {
    const file = extensionDir(`type ${coreType}\n`);
    assert.throws(
      () => validateExtension(file),
      new RegExp(`redeclares a type: ${coreType}`),
    );
  });
}

test("rejects an extension tests file that sets an inline model", () => {
  const file = extensionDir(
    `type folder
  relations
    define owner: [user]
`,
    `name: t
model_file: ./extension.fga
model: |
  model
    schema 1.1
  type user
tests: []
`,
  );
  assert.throws(() => validateExtension(file), /must not set an inline model/);
});

test("rejects an extension with no tests file", () => {
  const dir = mkdtempSync(join(tmpdir(), "riz-ext-"));
  writeFileSync(join(dir, "extension.fga"), "type folder\n");
  assert.throws(
    () => validateExtension(join(dir, "extension.fga")),
    /missing assertions file/,
  );
});

test("an extension relation fed by organization members grants no central role", () => {
  const file = extensionDir(
    `type group
  relations
    define viewer: [organization#member]
`,
    `name: t
model_file: ./extension.fga
tuples:
  - { user: user:mike, relation: member, object: organization:acme }
  - { user: organization:acme#member, relation: viewer, object: group:g1 }
  - { user: organization:acme, relation: organization, object: application:crm }
tests:
  - name: the extension relation works, the central roles do not follow
    check:
      - user: user:mike
        object: group:g1
        assertions: { viewer: true }
      - user: user:mike
        object: organization:acme
        assertions: { admin: false }
      - user: user:mike
        object: application:crm
        assertions: { admin: false }
`,
  );
  validateExtension(file);
});

test("rejects an indented redeclaration of a core type", () => {
  const file = extensionDir(`  type organization
    relations
      define admin: [user, user:*]
`);
  assert.throws(
    () => validateExtension(file),
    /redeclares a type: organization/,
  );
});

test("rejects an extension that carries its own model header", () => {
  const file = extensionDir(`model
  schema 1.1

type folder
  relations
    define owner: [user]
`);
  assert.throws(() => validateExtension(file), /types only/);
});

test("rejects an extension when the core suite fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "riz-core-"));
  // A core suite expecting members to be admins, which this core model denies.
  writeFileSync(
    join(dir, "core.fga"),
    `model
  schema 1.1

type user

type organization
  relations
    define admin: [user]
    define member: [user] or admin
`,
  );
  writeFileSync(
    join(dir, "core.tests.yaml"),
    `name: core
model_file: ./core.fga
tuples:
  - { user: user:mike, relation: member, object: organization:acme }
tests:
  - name: a member is not an admin
    check:
      - user: user:mike
        object: organization:acme
        assertions: { admin: true }
`,
  );
  const file = extensionDir(`type folder
  relations
    define owner: [user]
`);
  assert.throws(
    () => validateExtension(file, join(dir, "core.fga")),
    /core\.tests\.yaml: model assertions failed/,
  );
});

test("rejects an extension whose assertions fail", () => {
  const file = extensionDir(
    `type folder
  relations
    define owner: [user]
`,
    `name: t
model_file: ./extension.fga
tuples:
  - { user: user:olga, relation: owner, object: folder:f1 }
tests:
  - name: owner
    check:
      - user: user:olga
        object: folder:f1
        assertions: { owner: false }
`,
  );
  assert.throws(
    () => validateExtension(file),
    /extension\.tests\.yaml: model assertions failed/,
  );
});

// Integration: needs a running OpenFGA (OPENFGA_API_URL). Unverified until run against one.
test(
  "writeExtension stores the composed model, core types included",
  { skip: process.env.OPENFGA_API_URL ? false : "OPENFGA_API_URL not set" },
  async () => {
    const apiUrl = process.env.OPENFGA_API_URL as string;
    const { id: storeId } = await new OpenFgaClient({ apiUrl }).createStore({
      name: "extension-test",
    });

    const modelId = await writeExtension(
      join(modelsDir, "apps/crm/extension.fga"),
      {
        apiUrl,
        storeId,
      },
    );

    const { authorization_model } = await new OpenFgaClient({
      apiUrl,
      storeId,
    }).readAuthorizationModel({
      authorizationModelId: modelId,
    });
    const types = authorization_model?.type_definitions.map((t) => t.type);
    assert.deepEqual(types?.sort(), [
      "application",
      "document",
      "organization",
      "project",
      "team",
      "user",
    ]);
  },
);
