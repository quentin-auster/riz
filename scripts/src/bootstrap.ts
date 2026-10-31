import { OpenFgaClient } from "@openfga/sdk";
import { writeModel } from "./model.js";

export const ADMIN_STORE_NAME = "riz-admin";

// Same shape the API accepts for a subject, since it is spliced into `user:<sub>`.
const SUBJECT = /^[A-Za-z0-9._@+-]{1,128}$/;

/**
 * Creates riz's own admin store, writes the admin model and makes `admin` the
 * first security admin. The subject is supplied by the operator; nothing is
 * hardcoded. Refuses to run twice, so it cannot silently create a second store.
 */
export async function bootstrapAdmin(
  modelFile: string,
  target: { apiUrl: string; admin: string },
): Promise<{ storeId: string; modelId: string }> {
  if (!SUBJECT.test(target.admin)) {
    throw new Error("admin must be a plain subject (letters, digits, ._@+-)");
  }
  const lister = new OpenFgaClient({ apiUrl: target.apiUrl });
  let continuationToken: string | undefined;
  do {
    const page = await lister.listStores({
      pageSize: 100,
      ...(continuationToken ? { continuationToken } : {}),
    });
    if (page.stores.some((s) => s.name === ADMIN_STORE_NAME)) {
      throw new Error(
        `a store named ${ADMIN_STORE_NAME} already exists; grant roles by writing tuples to it`,
      );
    }
    continuationToken = page.continuation_token || undefined;
  } while (continuationToken);

  const { id: storeId } = await lister.createStore({ name: ADMIN_STORE_NAME });
  const modelId = await writeModel(modelFile, {
    apiUrl: target.apiUrl,
    storeId,
  });
  await new OpenFgaClient({
    apiUrl: target.apiUrl,
    storeId,
    authorizationModelId: modelId,
  }).write({
    writes: [
      {
        user: `user:${target.admin}`,
        relation: "security_admin",
        object: "organization:default",
      },
    ],
  });
  return { storeId, modelId };
}
