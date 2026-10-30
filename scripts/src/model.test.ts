import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { OpenFgaClient } from "@openfga/sdk";
import { validateModel, writeModel } from "./model.js";

const VALID_MODEL = `model
  schema 1.1

type user

type document
  relations
    define viewer: [user]
`;

const tests = (viewerOfD1: boolean) => `name: t
model_file: ./model.fga
tuples:
  - { user: user:anne, relation: viewer, object: document:d1 }
tests:
  - name: viewer
    check:
      - user: user:anne
        object: document:d1
        assertions: { viewer: ${viewerOfD1} }
`;

function modelDir(model: string, testsYaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "riz-model-"));
  writeFileSync(join(dir, "model.fga"), model);
  writeFileSync(join(dir, "tests.yaml"), testsYaml);
  return join(dir, "model.fga");
}

test("rejects a model that does not parse", () => {
  const file = modelDir("this is not a model", tests(true));
  assert.throws(() => validateModel(file));
});

test("rejects a model whose assertions fail", () => {
  const file = modelDir(VALID_MODEL, tests(false));
  assert.throws(() => validateModel(file), /assertions failed/);
});

test("accepts a model whose assertions pass", () => {
  validateModel(modelDir(VALID_MODEL, tests(true)));
});

test("accepts the repository base model", () => {
  validateModel(resolve(import.meta.dirname, "../../models/openfga/base.fga"));
});

// Integration: needs a running OpenFGA (OPENFGA_API_URL). Unverified until run against one.
test(
  "writing the same model twice yields two distinct IDs",
  { skip: process.env.OPENFGA_API_URL ? false : "OPENFGA_API_URL not set" },
  async () => {
    const apiUrl = process.env.OPENFGA_API_URL as string;
    const { id: storeId } = await new OpenFgaClient({ apiUrl }).createStore({
      name: "model-test",
    });
    const file = modelDir(VALID_MODEL, tests(true));

    const first = await writeModel(file, { apiUrl, storeId });
    const second = await writeModel(file, { apiUrl, storeId });

    assert.ok(first && second);
    assert.notEqual(first, second);
  },
);
