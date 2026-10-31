import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { bootstrapAdmin } from "./bootstrap.js";
import { validateModel, writeModel } from "./model.js";

const usage = `usage:
  pnpm model validate <model.fga>
  pnpm model write <model.fga> --store-id <id> [--api-url <url>]   (default OPENFGA_API_URL)
  pnpm model bootstrap-admin --admin <subject> [--api-url <url>]   (default OPENFGA_API_URL)`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    "store-id": { type: "string" },
    "api-url": { type: "string" },
    admin: { type: "string" },
  },
});
const [command, relativeFile] = positionals;

if (command === "bootstrap-admin") {
  const admin = values.admin;
  const apiUrl = values["api-url"] ?? process.env.OPENFGA_API_URL;
  if (!admin || !apiUrl) {
    console.error(usage);
    process.exit(2);
  }
  const { storeId, modelId } = await bootstrapAdmin(
    resolve(import.meta.dirname, "../../models/openfga/riz-admin.fga"),
    { apiUrl, admin },
  );
  console.log(`RIZ_ADMIN_STORE_ID=${storeId}`);
  console.log(`RIZ_ADMIN_MODEL_ID=${modelId}`);
  process.exit(0);
}

if (!relativeFile) {
  console.error(usage);
  process.exit(2);
}
// pnpm runs scripts from the package dir; INIT_CWD is where the user invoked it.
const modelFile = resolve(process.env.INIT_CWD ?? process.cwd(), relativeFile);

if (command === "validate") {
  validateModel(modelFile);
  console.log("ok");
} else if (command === "write") {
  const storeId = values["store-id"];
  const apiUrl = values["api-url"] ?? process.env.OPENFGA_API_URL;
  if (!storeId || !apiUrl) {
    console.error(usage);
    process.exit(2);
  }
  console.log(await writeModel(modelFile, { apiUrl, storeId }));
} else {
  console.error(usage);
  process.exit(2);
}
