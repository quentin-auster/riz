import { error, fail } from "@sveltejs/kit";
import { callApi, mutate } from "$lib/server/call";
import { grant, revoke } from "$lib/server/relationships";
import type { Actions, PageServerLoad } from "./$types";

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

const applicationOf = (id: string) => {
  // Checked before it is put in an API path.
  if (!ID.test(id)) error(404, "Application not found.");
  return id;
};

export const load: PageServerLoad = async ({ locals, params, url }) => {
  const application = applicationOf(params.id);
  const object = url.searchParams.get("object")?.trim() ?? "";
  const relation = url.searchParams.get("relation")?.trim() ?? "";
  const cursor = url.searchParams.get("cursor");
  if (relation && !object) {
    return {
      application,
      object,
      relation,
      items: [],
      nextCursor: null,
      canWrite: false,
      filterError:
        "Filtering by relation needs an object, for example team:eng.",
    };
  }

  const query = new URLSearchParams({ application, limit: "100" });
  if (object) query.set("object", object);
  if (relation) query.set("relation", relation);
  if (cursor) query.set("cursor", cursor);
  const [me, page] = await Promise.all([
    callApi<{ scopes: string[]; applications: string[] }>(locals, "/v1/me"),
    callApi<{
      items: { subject: string; relation: string; object: string }[];
      nextCursor?: string;
    }>(locals, `/v1/relationships?${query}`),
  ]);
  return {
    application,
    object,
    relation,
    items: page.items,
    nextCursor: page.nextCursor ?? null,
    // A hint for what to show; the API still authorizes every change.
    canWrite:
      me.scopes.includes("relationships:write") &&
      (me.applications.includes("*") || me.applications.includes(application)),
    filterError: null,
  };
};

export const actions: Actions = {
  grant: async ({ locals, params, request }) => {
    const result = await grant(
      (path, init) => mutate(locals, path, init),
      applicationOf(params.id),
      await request.formData(),
    );
    return result.status === 200 ? result : fail(result.status, result);
  },
  revoke: async ({ locals, params, request }) => {
    const result = await revoke(
      (path, init) => mutate(locals, path, init),
      applicationOf(params.id),
      await request.formData(),
    );
    return result.status === 200 ? result : fail(result.status, result);
  },
};
