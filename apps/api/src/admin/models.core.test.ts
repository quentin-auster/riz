import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type pg from "pg";
import { createModelService } from "./models.js";

// Core checks run before any OpenFGA or database call, so no infrastructure is needed:
// every case below must be refused before the (unreachable) apiUrl is touched.
const core = readFileSync(
  join(import.meta.dirname, "../../../../models/openfga/core.fga"),
  "utf8",
);
const service = createModelService({
  pool: {} as pg.Pool,
  lookup: async () => ({ storeId: "store", modelId: null }),
  apiUrl: "http://127.0.0.1:1",
  core,
});
const noCoreService = createModelService({
  pool: {} as pg.Pool,
  lookup: async () => ({ storeId: "store", modelId: null }),
  apiUrl: "http://127.0.0.1:1",
});

const assertions = [
  {
    subject: "user:a",
    relation: "admin",
    object: "organization:o",
    allowed: true,
  },
  {
    subject: "user:b",
    relation: "admin",
    object: "organization:o",
    allowed: false,
  },
];
const submit = (input: { model?: string; extension?: string }, svc = service) =>
  svc.submit("actor", "crm-prod", { tuples: [], assertions, ...input });

const folder = `type folder
  relations
    define owner: [user]
`;

test("refuses an extension that redeclares a core type", async () => {
  await assert.rejects(
    submit({
      extension: `type organization
  relations
    define admin: [user, user:*]
`,
    }),
    /Core type\(s\) missing, repeated or changed: organization/,
  );
});

test("refuses an indented redeclaration of a core type", async () => {
  await assert.rejects(
    submit({
      extension: `  type application
    relations
      define admin: [user]
`,
    }),
    /missing, repeated or changed: application/,
  );
});

test("refuses a full model that weakens a core role", async () => {
  // Anyone may now be an organization admin: the central rule is gone.
  const weakened = core.replace(
    "define admin: [user]\n    define member",
    "define admin: [user, user:*]\n    define member",
  );
  assert.notEqual(weakened, core);
  await assert.rejects(
    submit({ model: weakened }),
    /missing, repeated or changed: organization/,
  );
});

test("refuses a full model that drops a core type", async () => {
  await assert.rejects(
    submit({ model: `model\n  schema 1.1\n\ntype user\n\n${folder}` }),
    /missing, repeated or changed: organization, application/,
  );
});

test("refuses an extension with a model header", async () => {
  await assert.rejects(
    submit({ extension: `model\n  schema 1.1\n\n${folder}` }),
    /types only/,
  );
});

test("refuses an extension when the deployment has no core model", async () => {
  await assert.rejects(
    submit({ extension: folder }, noCoreService),
    /no core model/,
  );
});

const base = readFileSync(
  join(import.meta.dirname, "../../../../models/openfga/base.fga"),
  "utf8",
);

test("a base-derived full model passes the core check", async () => {
  // It gets past the core check and fails later, at the unreachable OpenFGA.
  await assert.rejects(
    submit({ model: base }),
    (err: Error) => !/Core type/.test(err.message),
  );
});

test("refuses a full model that repeats a core type", async () => {
  await assert.rejects(
    submit({ model: `${base}\ntype user\n` }),
    /missing, repeated or changed: user/,
  );
});

test("refuses to start with a core that references a non-core type", () => {
  assert.throws(
    () =>
      createModelService({
        pool: {} as pg.Pool,
        lookup: async () => null,
        apiUrl: "http://127.0.0.1:1",
        core: `model
  schema 1.1

type user

type widget
  relations
    define owner: [gadget]
`,
      }),
    /references non-core type gadget/,
  );
});

test("refuses to start with a core that defines no types", () => {
  assert.throws(() =>
    createModelService({
      pool: {} as pg.Pool,
      lookup: async () => null,
      apiUrl: "http://127.0.0.1:1",
      core: "model\n  schema 1.1\n",
    }),
  );
});
