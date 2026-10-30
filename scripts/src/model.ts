import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { OpenFgaClient } from "@openfga/sdk";
import { transformer } from "@openfga/syntax-transformer";

// Keep in sync with FGA_CLI in the Makefile.
export const FGA_CLI_IMAGE = "openfga/cli:v0.8.2";

type ModelJson = ReturnType<typeof transformer.transformDSLToJSONObject>;

function parse(modelFile: string): ModelJson {
  return transformer.transformDSLToJSONObject(readFileSync(modelFile, "utf8"));
}

/**
 * Rejects a model that does not parse, or whose sibling tests.yaml assertions fail.
 * Layout: <dir>/<name>.fga with its assertions in <dir>/tests.yaml.
 */
export function validateModel(modelFile: string): ModelJson {
  const file = resolve(modelFile);
  const model = parse(file);

  // The assertions must target the model we validate (and later write), not a sibling file.
  const testsFile = `${dirname(file)}/tests.yaml`;
  const target = readFileSync(testsFile, "utf8").match(
    /^model_file:\s*(\S+)/m,
  )?.[1];
  if (!target || resolve(dirname(file), target) !== file) {
    throw new Error(
      `${testsFile} must set model_file to ${basename(file)}, got ${target}`,
    );
  }

  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "-v",
      `${dirname(file)}:/models:ro`,
      FGA_CLI_IMAGE,
      "model",
      "test",
      "--tests",
      "/models/tests.yaml",
    ],
    { encoding: "utf8" },
  );
  if (result.error) {
    throw new Error(
      `could not run the fga CLI via docker: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    const tail = `${result.stdout}${result.stderr}`
      .trim()
      .split("\n")
      .slice(-30)
      .join("\n");
    throw new Error(`model assertions failed for ${basename(file)}:\n${tail}`);
  }
  return model;
}

/**
 * Validates the model, writes it to the store and returns the new model ID.
 * Every write creates a new immutable ID; callers must pin it explicitly and
 * never rely on "latest".
 */
export async function writeModel(
  modelFile: string,
  target: { apiUrl: string; storeId: string },
): Promise<string> {
  const model = validateModel(modelFile);
  const client = new OpenFgaClient({
    apiUrl: target.apiUrl,
    storeId: target.storeId,
  });
  const { authorization_model_id } =
    await client.writeAuthorizationModel(model);
  if (!authorization_model_id) {
    throw new Error("OpenFGA did not return an authorization_model_id");
  }
  return authorization_model_id;
}
