import { parseArgs } from "node:util";
import { validateModel, writeModel } from "./model.js";

const usage = `usage:
  pnpm model validate <model.fga>
  pnpm model write <model.fga> --store-id <id> [--api-url <url>]   (default OPENFGA_API_URL)`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { "store-id": { type: "string" }, "api-url": { type: "string" } },
});
const [command, modelFile] = positionals;

if (!modelFile) {
  console.error(usage);
  process.exit(2);
}

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
