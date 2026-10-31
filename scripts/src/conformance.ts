import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import AjvModule from "ajv/dist/2020.js";
import { parse } from "yaml";

// ajv is CommonJS: under NodeNext the class is the module's `default` property.
const Ajv2020 = AjvModule.default;

type Json = Record<string, unknown>;

const OPERATIONS: Record<
  string,
  { path: string; request: string; response: string }
> = {
  check: {
    path: "/v1/check",
    request: "CheckRequest",
    response: "CheckResponse",
  },
  batchCheck: {
    path: "/v1/batch-check",
    request: "BatchCheckRequest",
    response: "BatchCheckResponse",
  },
};

/**
 * Returns what is wrong with the SDK conformance cases in `casesDir`, judged
 * against the OpenAPI contract: request bodies and responses must conform,
 * except responses a case flags `nonconformingResponse` (fail-closed tests that
 * model a misbehaving server), which must really not conform.
 */
export function conformanceProblems(
  casesDir: string,
  specFile: string,
): string[] {
  const spec = parse(readFileSync(specFile, "utf8")) as Json;
  // OpenAPI keywords such as `examples` and formats are not under test here.
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  ajv.addSchema(spec, "openapi");
  const valid = (schema: string, data: unknown) =>
    (ajv.getSchema(`openapi#/components/schemas/${schema}`) ?? fail(schema))(
      data,
    );
  const paths = spec.paths as Record<string, { post?: { responses: Json } }>;

  const problems: string[] = [];
  const files = readdirSync(casesDir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  if (files.length === 0) problems.push(`no cases in ${casesDir}`);

  for (const file of files) {
    const c = JSON.parse(readFileSync(join(casesDir, file), "utf8")) as Json;
    const say = (msg: string) => problems.push(`${file}: ${msg}`);
    const op = OPERATIONS[(c.call as Json | undefined)?.operation as string];
    if (!op) {
      say("call.operation must be check or batchCheck");
      continue;
    }
    const declared = paths[op.path]?.post?.responses ?? {};

    const req = c.expectRequest as
      | { method?: string; path?: string; body?: unknown }
      | undefined;
    if (req) {
      if (req.method !== "POST" || req.path !== op.path) {
        say(`expectRequest must be POST ${op.path}`);
      }
      if (req.body !== undefined && !valid(op.request, req.body)) {
        say(`request body does not conform to ${op.request}`);
      }
    }

    const res = (c.response ?? {}) as { status?: number; body?: unknown };
    if (res.status !== undefined) {
      const conforms =
        String(res.status) in declared &&
        valid(res.status === 200 ? op.response : "Error", res.body);
      if (c.nonconformingResponse === true && conforms) {
        say("response conforms, so remove nonconformingResponse");
      } else if (c.nonconformingResponse !== true && !conforms) {
        say(`response ${res.status} does not conform to the contract`);
      }
    }

    const expect = (c.expect ?? {}) as Json;
    if ("result" in expect === "error" in expect) {
      say("expect must have exactly one of result or error");
    }
  }
  return problems;
}

function fail(schema: string): never {
  throw new Error(`schema ${schema} not found in the contract`);
}
