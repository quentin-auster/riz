import { OpenFgaClient } from "@openfga/sdk";
import { HttpError } from "../http.js";

export type OrganizationRelation =
  | "can_register_application"
  | "can_manage_bindings"
  | "can_read_applications"
  | "can_read_audit";

export type ApplicationRelation =
  | "can_read"
  | "can_manage_relationships"
  | "can_manage_model"
  | "can_read_audit";

export const ORGANIZATION = "organization:default";

// The subject is spliced into `user:<subject>`; anything outside this set (`:`, `#`, `|`, spaces)
// could name another OpenFGA object, so it is denied rather than escaped.
const SUBJECT = /^[A-Za-z0-9._@+-]{1,128}$/;
const APPLICATION_ID = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Decides who may administer riz itself, against the riz-admin store at a pinned
 * model. Separate from application checks: it never touches an application's store.
 * Fails closed: an OpenFGA outage is a 503, never an allow.
 */
export function createAdminAuthorizer(config: {
  apiUrl: string;
  storeId: string;
  modelId: string;
}) {
  const client = new OpenFgaClient({
    apiUrl: config.apiUrl,
    storeId: config.storeId,
    authorizationModelId: config.modelId,
  });
  const unavailable = () =>
    new HttpError(
      503,
      "authorization_unavailable",
      "admin authorization is unavailable",
    );

  async function check(
    subject: string,
    relation: string,
    object: string,
  ): Promise<boolean> {
    if (!SUBJECT.test(subject)) return false;
    try {
      const { allowed } = await client.check({
        user: `user:${subject}`,
        relation,
        object,
      });
      return allowed === true;
    } catch {
      throw unavailable();
    }
  }

  return {
    organization: (subject: string, relation: OrganizationRelation) =>
      check(subject, relation, ORGANIZATION),

    application(
      subject: string,
      relation: ApplicationRelation,
      applicationId: string,
    ): Promise<boolean> {
      if (!APPLICATION_ID.test(applicationId)) return Promise.resolve(false);
      return check(subject, relation, `application:${applicationId}`);
    },

    /** Application IDs the subject can_read, for filtering list endpoints. */
    async readableApplications(subject: string): Promise<string[]> {
      if (!SUBJECT.test(subject)) return [];
      try {
        const { objects } = await client.listObjects({
          user: `user:${subject}`,
          relation: "can_read",
          type: "application",
        });
        return objects.map((o) => o.slice("application:".length));
      } catch {
        throw unavailable();
      }
    },
  };
}

export type AdminAuthorizer = ReturnType<typeof createAdminAuthorizer>;
