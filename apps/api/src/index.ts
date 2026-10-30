import { readFileSync } from "node:fs";
import { join } from "node:path";
import { transformer } from "@openfga/syntax-transformer";
import pg from "pg";
import { adminRoutes } from "./admin/routes.js";
import { createAdminService } from "./admin/service.js";
import { authenticatorFromEnv, endUserVerifierFromEnv } from "./auth/index.js";
import { createResolver, dbLookup } from "./checks/resolver.js";
import { checkRoutes } from "./checks/routes.js";
import { createCheckService } from "./checks/service.js";
import { migrate } from "./db/migrate.js";
import { createApp } from "./server.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const authenticate = authenticatorFromEnv(process.env);
const pool = new pg.Pool({ connectionString: required("RIZ_DATABASE_URL") });

const migrator = await pool.connect();
try {
  await migrate(migrator);
} finally {
  migrator.release();
}

const baseModel = transformer.transformDSLToJSONObject(
  readFileSync(
    join(import.meta.dirname, "../../../models/openfga/base.fga"),
    "utf8",
  ),
);
const admin = createAdminService({
  pool,
  apiUrl: required("OPENFGA_API_URL"),
  baseModel,
});

const checkTimeoutMs = Number(process.env.RIZ_CHECK_TIMEOUT_MS ?? 2000);
if (!Number.isInteger(checkTimeoutMs) || checkTimeoutMs < 1) {
  throw new Error("RIZ_CHECK_TIMEOUT_MS must be a positive integer");
}
// The contract caps a batch at 100; operators may only lower it.
const maxBatchSize = Number(process.env.RIZ_BATCH_MAX ?? 100);
if (!Number.isInteger(maxBatchSize) || maxBatchSize < 1 || maxBatchSize > 100) {
  throw new Error("RIZ_BATCH_MAX must be an integer from 1 to 100");
}
const checks = checkRoutes({
  maxBatchSize,
  service: createCheckService({
    resolver: createResolver(dbLookup(pool), required("OPENFGA_API_URL")),
    timeoutMs: checkTimeoutMs,
  }),
  verifyEndUser: endUserVerifierFromEnv(process.env),
});
const adminHandler = adminRoutes(admin);

const port = Number(process.env.PORT ?? 8080);
createApp({
  authenticate,
  routes: async (req, res, principal, url) =>
    (await adminHandler(req, res, principal, url)) ||
    checks(req, res, principal, url),
}).listen(port, "0.0.0.0", () => {
  console.log(JSON.stringify({ msg: "riz api listening", port }));
});
