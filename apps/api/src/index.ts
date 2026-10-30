import { readFileSync } from "node:fs";
import { join } from "node:path";
import { transformer } from "@openfga/syntax-transformer";
import pg from "pg";
import { adminRoutes } from "./admin/routes.js";
import { createAdminService } from "./admin/service.js";
import { authenticatorFromEnv } from "./auth/index.js";
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

const port = Number(process.env.PORT ?? 8080);
createApp({ authenticate, routes: adminRoutes(admin) }).listen(
  port,
  "0.0.0.0",
  () => {
    console.log(JSON.stringify({ msg: "riz api listening", port }));
  },
);
