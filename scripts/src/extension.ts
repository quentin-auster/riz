import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { OpenFgaClient } from "@openfga/sdk";
import { transformer } from "@openfga/syntax-transformer";
import { validateModel } from "./model.js";

const CORE_FILE = resolve(import.meta.dirname, "../../models/openfga/core.fga");

const testsFor = (modelFile: string) =>
  modelFile.replace(/\.fga$/, ".tests.yaml");

/**
 * Composes the riz core model with an application's extension (types only) and
 * returns the composed model once both suites pass against it. An extension may
 * reference core types but not redeclare them, so it cannot change a central role.
 */
export function validateExtension(
  extensionFile: string,
  coreFile = CORE_FILE,
): ReturnType<typeof validateModel> {
  const extPath = resolve(extensionFile);
  const core = readFileSync(coreFile, "utf8");
  const extension = readFileSync(extPath, "utf8");

  if (/^\s*model\b/m.test(extension)) {
    throw new Error(
      `${basename(extPath)} must hold types only, without a model header`,
    );
  }
  // Judge the parsed model, not the source text: indentation must not hide a redeclaration.
  const seen = new Set<string>();
  const clash = new Set<string>();
  for (const { type } of transformer.transformDSLToJSONObject(
    `${core}\n${extension}`,
  ).type_definitions) {
    if (seen.has(type)) clash.add(type);
    seen.add(type);
  }
  if (clash.size > 0) {
    throw new Error(
      `${basename(extPath)} redeclares a type: ${[...clash].join(", ")}`,
    );
  }

  let model: ReturnType<typeof validateModel> | undefined;
  for (const tests of [testsFor(coreFile), testsFor(extPath)]) {
    const dir = mkdtempSync(join(tmpdir(), "riz-compose-"));
    try {
      // The CLI container runs as another user; on Linux a 0700 mkdtemp dir is unreadable to it.
      chmodSync(dir, 0o755);
      writeFileSync(join(dir, "model.fga"), `${core}\n${extension}`);
      writeFileSync(
        join(dir, "tests.yaml"),
        readFileSync(tests, "utf8").replace(
          /^model_file:.*$/m,
          "model_file: ./model.fga",
        ),
      );
      model = validateModel(join(dir, "model.fga"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return model as ReturnType<typeof validateModel>;
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
