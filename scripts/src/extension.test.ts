import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { validateExtension } from "./extension.js";

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
  assert.throws(() => validateExtension(file), /redeclares a type: organization/);
});

test("rejects an indented redeclaration of a core type", () => {
  const file = extensionDir(`  type organization
    relations
      define admin: [user, user:*]
`);
  assert.throws(() => validateExtension(file), /redeclares a type: organization/);
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
  assert.throws(() => validateExtension(file), /assertions failed/);
});
