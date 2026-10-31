import { randomUUID } from "node:crypto";
import { ConsistencyPreference, OpenFgaClient } from "@openfga/sdk";
import { transformer } from "@openfga/syntax-transformer";
import type pg from "pg";
import { ApplicationNotFound, type Lookup } from "../checks/resolver.js";
import { HttpError } from "../http.js";
import { recordAudit } from "./audit.js";
import {
  fga,
  InvalidRelationship,
  type Relationship,
} from "./relationships.js";
import type { ModelEntry } from "./service.js";

export interface Assertion extends Relationship {
  allowed: boolean;
}

/** The submitted model or its assertions are unusable (syntax, types, or shape). */
export class InvalidModel extends Error {}
/** The model parsed, but its assertions do not hold; the binding is not changed. */
export class AssertionsFailed extends Error {}
export class ModelNotFound extends Error {}
export class ModelAlreadyActive extends Error {}

const toEntry = (r: {
  model_id: string;
  bound_at: Date;
  active: boolean;
}): ModelEntry => ({
  id: r.model_id,
  createdAt: r.bound_at.toISOString(),
  active: r.active,
});

/**
 * A model reaches an application only through a new immutable model ID that is then
 * bound; no request ever resolves "latest" and no other application is touched.
 */
export function createModelService(deps: {
  pool: pg.Pool;
  lookup: Lookup;
  apiUrl: string;
}) {
  const { pool, lookup, apiUrl } = deps;

  /**
   * Runs the assertions against the candidate in a scratch store, so neither a failing
   * model nor the assertion tuples ever touch the application's store.
   */
  async function runAssertions(
    dsl: string,
    tuples: Relationship[],
    assertions: Assertion[],
  ): Promise<void> {
    let json: ReturnType<typeof transformer.transformDSLToJSONObject>;
    try {
      json = transformer.transformDSLToJSONObject(dsl);
    } catch (err) {
      throw new InvalidModel(
        `Model does not parse: ${String(err).slice(0, 200)}`,
      );
    }
    const invalid = (m: string) => new InvalidModel(m);

    const { id: storeId } = await fga(
      () =>
        new OpenFgaClient({ apiUrl }).createStore({
          name: `riz-validate-${randomUUID()}`,
        }),
      invalid,
    );
    try {
      const { authorization_model_id: modelId } = await fga(
        () =>
          new OpenFgaClient({ apiUrl, storeId }).writeAuthorizationModel(json),
        invalid,
      );
      const scratch = new OpenFgaClient({
        apiUrl,
        storeId,
        ...(modelId ? { authorizationModelId: modelId } : {}),
      });
      if (tuples.length) {
        await fga(
          () =>
            scratch.write({
              writes: tuples.map((t) => ({
                user: t.subject,
                relation: t.relation,
                object: t.object,
              })),
            }),
          (m) => new InvalidRelationship(m),
        );
      }
      const failed: number[] = [];
      for (const [i, a] of assertions.entries()) {
        const { allowed } = await fga(
          () =>
            scratch.check(
              { user: a.subject, relation: a.relation, object: a.object },
              { consistency: ConsistencyPreference.HigherConsistency },
            ),
          (m) => new InvalidRelationship(m),
        );
        if ((allowed === true) !== a.allowed) failed.push(i);
      }
      if (failed.length) {
        throw new AssertionsFailed(`Assertions failed: #${failed.join(", #")}`);
      }
    } finally {
      // shortcut: a failed delete leaves an inert riz-validate-* store; add a janitor
      // when scratch stores start to accumulate.
      await new OpenFgaClient({ apiUrl, storeId })
        .deleteStore()
        .catch(() => {});
    }
  }

  /** Swaps the active binding under a lock on the application, with its audit event. */
  async function bind(
    actor: string,
    application: string,
    modelId: string,
    action: "models.bind" | "models.rollback",
    requestId: string | undefined,
    mustExist: boolean,
  ): Promise<ModelEntry> {
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      const locked = await db.query(
        "SELECT 1 FROM applications WHERE id = $1 FOR UPDATE",
        [application],
      );
      if (!locked.rowCount) throw new ApplicationNotFound(application);

      const prior = (
        await db.query<{ model_id: string }>(
          "SELECT model_id FROM model_bindings WHERE application_id = $1 AND active",
          [application],
        )
      ).rows[0]?.model_id;
      if (prior === modelId) throw new ModelAlreadyActive();

      if (mustExist) {
        const known = await db.query(
          "SELECT 1 FROM model_bindings WHERE application_id = $1 AND model_id = $2",
          [application, modelId],
        );
        if (!known.rowCount) throw new ModelNotFound();
      }

      await db.query(
        "UPDATE model_bindings SET active = false WHERE application_id = $1 AND active",
        [application],
      );
      const { rows } = await db.query(
        `INSERT INTO model_bindings (application_id, model_id, active)
         VALUES ($1, $2, true)
         ON CONFLICT (application_id, model_id) DO UPDATE SET active = true
         RETURNING model_id, bound_at, active`,
        [application, modelId],
      );
      await recordAudit(db, {
        actor,
        action,
        applicationId: application,
        requestId,
        detail: {
          before: prior ? { modelId: prior } : null,
          after: { modelId },
        },
      });
      await db.query("COMMIT");
      return toEntry(rows[0]);
    } catch (err) {
      await db.query("ROLLBACK");
      throw err;
    } finally {
      db.release();
    }
  }

  return {
    /** Validate, assert, write a new immutable model, then bind it. The prior row stays as history. */
    async submit(
      actor: string,
      application: string,
      input: { model: string; tuples: Relationship[]; assertions: Assertion[] },
      requestId?: string,
    ): Promise<ModelEntry> {
      const found = await lookup(application);
      if (!found) throw new ApplicationNotFound(application);

      await runAssertions(input.model, input.tuples, input.assertions);

      const { authorization_model_id: modelId } = await fga(
        () =>
          new OpenFgaClient({
            apiUrl,
            storeId: found.storeId,
          }).writeAuthorizationModel(
            transformer.transformDSLToJSONObject(input.model),
          ),
        (m) => new InvalidModel(m),
      );
      if (!modelId) {
        throw new HttpError(
          503,
          "authorization_unavailable",
          "The authorization store did not return a model ID.",
        );
      }
      // If binding fails the new model is inert: nothing resolves an unbound ID.
      return bind(actor, application, modelId, "models.bind", requestId, false);
    },

    /** Re-binds a model this application has been bound to before. */
    async rollback(
      actor: string,
      application: string,
      modelId: string,
      requestId?: string,
    ): Promise<ModelEntry> {
      return bind(
        actor,
        application,
        modelId,
        "models.rollback",
        requestId,
        true,
      );
    },
  };
}

export type ModelService = ReturnType<typeof createModelService>;
