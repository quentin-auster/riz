import { readFileSync } from "node:fs";
import { join } from "node:path";
import { transformer } from "@openfga/syntax-transformer";
import pg from "pg";
import { createAdminAuthorizer } from "./admin/authorizer.js";
import { withAdminScopes } from "./admin/elevate.js";
import { explorerRoutes } from "./admin/explorerRoutes.js";
import { modelRoutes } from "./admin/modelRoutes.js";
import { createModelService } from "./admin/models.js";
import { relationshipRoutes } from "./admin/relationshipRoutes.js";
import { createRelationshipService } from "./admin/relationships.js";
import { adminRoutes } from "./admin/routes.js";
import { createAdminService } from "./admin/service.js";
import {
  authenticatorFromEnv,
  endUserVerifierFromEnv,
  oidcAuthFromEnv,
  type Principal,
} from "./auth/index.js";
import { workloadRoutes } from "./auth/workloadRoutes.js";
import { createBindingStore } from "./auth/workloads.js";
import { createResolver, dbLookup } from "./checks/resolver.js";
import { checkRoutes } from "./checks/routes.js";
import { createCheckService } from "./checks/service.js";
import { migrate } from "./db/migrate.js";
import { readiness } from "./health.js";
import { setupObservability } from "./observability.js";
import { providerRoutes } from "./providers/routes.js";
import { createProviderService } from "./providers/service.js";
import { createApp } from "./server.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

setupObservability(process.env);

const pool = new pg.Pool({
  connectionString: required("RIZ_DATABASE_URL"),
  // A saturated pool must fail a request, not hang it.
  connectionTimeoutMillis: 5000,
});
// An idle-client error (e.g. Postgres restart) must not crash the process.
pool.on("error", () => console.error(JSON.stringify({ msg: "pool error" })));

const bindings = createBindingStore(pool);
const { authenticate, verifyEndUser } =
  process.env.RIZ_AUTH_MODE === "oidc"
    ? oidcAuthFromEnv(process.env, bindings.lookup)
    : {
        authenticate: authenticatorFromEnv(process.env),
        verifyEndUser: endUserVerifierFromEnv(process.env),
      };

// Fixture principals carry their scopes; an oidc workload's admin scopes come from the riz-admin store.
const withAdmin: (p: Principal) => Promise<Principal> =
  process.env.RIZ_AUTH_MODE === "oidc"
    ? withAdminScopes(
        createAdminAuthorizer({
          apiUrl: required("OPENFGA_API_URL"),
          storeId: required("RIZ_ADMIN_STORE_ID"),
          modelId: required("RIZ_ADMIN_MODEL_ID"),
        }),
      )
    : async (p) => p;

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
const resolver = createResolver(dbLookup(pool), required("OPENFGA_API_URL"));
const checkService = createCheckService({
  resolver,
  timeoutMs: checkTimeoutMs,
});
const checks = checkRoutes({
  maxBatchSize,
  service: checkService,
  verifyEndUser,
});
const explorerHandler = explorerRoutes({ checks: checkService, pool });
const adminHandler = adminRoutes(admin);
const relationshipsHandler = relationshipRoutes(
  createRelationshipService({ pool, resolver }),
);
const modelsHandler = modelRoutes(
  createModelService({
    pool,
    lookup: dbLookup(pool),
    apiUrl: required("OPENFGA_API_URL"),
    core: readFileSync(
      join(import.meta.dirname, "../../../models/openfga/core.fga"),
      "utf8",
    ),
  }),
);
const bindingsHandler = workloadRoutes(bindings);
const providersHandler = providerRoutes(createProviderService({ pool }));
const readyTimeoutMs = Number(process.env.RIZ_READY_TIMEOUT_MS ?? 1000);
if (!Number.isInteger(readyTimeoutMs) || readyTimeoutMs < 1) {
  throw new Error("RIZ_READY_TIMEOUT_MS must be a positive integer");
}

const ADMIN_PATH =
  /^\/v1\/(me|applications|audit|models|providers|relationships|workload-bindings|explorer)(\/|$)/;

const port = Number(process.env.PORT ?? 8080);
createApp({
  authenticate,
  readiness: readiness({
    pool,
    openfgaUrl: required("OPENFGA_API_URL"),
    timeoutMs: readyTimeoutMs,
  }),
  routes: async (req, res, principal, url) => {
    // Checks first and with the caller as authenticated: the check path never waits on the admin store.
    if (await checks(req, res, principal, url)) return true;
    // Unknown paths fall through to a 404 without asking the admin store.
    if (!ADMIN_PATH.test(url.pathname)) return false;
    const admin = await withAdmin(principal);
    return (
      (await adminHandler(req, res, admin, url)) ||
      (await relationshipsHandler(req, res, admin, url)) ||
      (await modelsHandler(req, res, admin, url)) ||
      (await explorerHandler(req, res, admin, url)) ||
      (await bindingsHandler(req, res, admin, url)) ||
      (await providersHandler(req, res, admin, url))
    );
  },
}).listen(port, "0.0.0.0", () => {
  console.log(JSON.stringify({ msg: "riz api listening", port }));
});
