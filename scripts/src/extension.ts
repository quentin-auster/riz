import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { OpenFgaClient } from "@openfga/sdk";
import { transformer } from "@openfga/syntax-transformer";
import { parse } from "yaml";
import { validateModel } from "./model.js";

const CORE_FILE = resolve(import.meta.dirname, "../../models/openfga/core.fga");

const testsFor = (modelFile: string) =>
  modelFile.replace(/\.fga$/, ".tests.yaml");

type Model = ReturnType<typeof validateModel>;

/** Runs one assertion suite against the composed model, naming the suite in any failure. */
function runSuite(testsFile: string, composed: string): Model {
  if (!existsSync(testsFile)) {
    throw new Error(`missing assertions file ${testsFile}`);
  }
  const yaml = readFileSync(testsFile, "utf8");
  // The fga CLI tests an inline `model:` instead of model_file, so the suite would skip the composed model.
  if ("model" in ((parse(yaml) as Record<string, unknown> | null) ?? {})) {
    throw new Error(`${basename(testsFile)} must not set an inline model`);
  }
  const dir = mkdtempSync(join(tmpdir(), "riz-compose-"));
  try {
    // The CLI container runs as another user; on Linux a 0700 mkdtemp dir is unreadable to it.
    chmodSync(dir, 0o755);
    writeFileSync(join(dir, "model.fga"), composed);
    writeFileSync(
      join(dir, "tests.yaml"),
      yaml.replace(/^model_file:.*$/m, "model_file: ./model.fga"),
    );
    return validateModel(join(dir, "model.fga"));
  } catch (e) {
    throw new Error(`${basename(testsFile)}: ${(e as Error).message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Composes the riz core model with an application's extension (types only) and
 * returns the composed model once both suites pass against it. An extension may
 * reference core types but not redeclare them, so it cannot change a central role.
 */
export function validateExtension(
  extensionFile: string,
  coreFile = CORE_FILE,
): Model {
  const extPath = resolve(extensionFile);
  const core = readFileSync(coreFile, "utf8");
  const extension = readFileSync(extPath, "utf8");

  if (/^\s*model\b/m.test(extension)) {
    throw new Error(
      `${basename(extPath)} must hold types only, without a model header`,
    );
  }
  const composed = `${core}\n${extension}`;
  // Judge the parsed model, not the source text: indentation must not hide a redeclaration.
  const seen = new Set<string>();
  const clash = new Set<string>();
  for (const { type } of transformer.transformDSLToJSONObject(composed)
    .type_definitions) {
    if (seen.has(type)) clash.add(type);
    seen.add(type);
  }
  if (clash.size > 0) {
    throw new Error(
      `${basename(extPath)} redeclares a type: ${[...clash].join(", ")}`,
    );
  }

  const model = runSuite(testsFor(coreFile), composed);
  runSuite(testsFor(extPath), composed);
  return model;
}

/** Validates the composed model, writes it to the store and returns the new model ID. */
export async function writeExtension(
  extensionFile: string,
  target: { apiUrl: string; storeId: string },
): Promise<string> {
  const model = validateExtension(extensionFile);
  const { authorization_model_id } = await new OpenFgaClient(
    target,
  ).writeAuthorizationModel(model);
  if (!authorization_model_id) {
    throw new Error("OpenFGA did not return an authorization_model_id");
  }
  return authorization_model_id;
}
