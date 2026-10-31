import { error, fail } from "@sveltejs/kit";
import { callApi, mutate } from "$lib/server/call";
import { type DiffLine, lineDiff } from "$lib/server/diff";
import { MODEL_ID, rollback } from "$lib/server/models";
import type { Actions, PageServerLoad } from "./$types";

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

const applicationOf = (value: string | null | undefined) => {
  // Checked before it is put in an API path.
  if (!value || !ID.test(value)) error(404, "Application not found.");
  return value;
};

interface ModelEntry {
  id: string;
  createdAt: string;
  active: boolean;
}

export const load: PageServerLoad = async ({ locals, url }) => {
  const raw = url.searchParams.get("application")?.trim();
  if (!raw) {
    return {
      application: "",
      models: [] as ModelEntry[],
      nextCursor: null,
      canWrite: false,
      diff: null as { from: string; to: string; lines: DiffLine[] } | null,
    };
  }
  const application = applicationOf(raw);
  const cursor = url.searchParams.get("cursor");
  const query = new URLSearchParams({ application, limit: "100" });
  if (cursor) query.set("cursor", cursor);
  const [me, page] = await Promise.all([
    callApi<{ scopes: string[]; applications: string[] }>(locals, "/v1/me"),
    callApi<{ items: ModelEntry[]; nextCursor?: string }>(
      locals,
      `/v1/models?${query}`,
    ),
  ]);

  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  let diff: { from: string; to: string; lines: DiffLine[] } | null = null;
  if (from && to) {
    if (!MODEL_ID.test(from) || !MODEL_ID.test(to)) {
      error(400, "Model ID is not valid.");
    }
    const read = (id: string) =>
      callApi<{ model: string }>(
        locals,
        `/v1/models/${id}?application=${application}`,
      );
    const [before, after] = await Promise.all([read(from), read(to)]);
    diff = { from, to, lines: lineDiff(before.model, after.model) };
  }

  return {
    application,
    models: page.items,
    nextCursor: page.nextCursor ?? null,
    // A hint for what to show; the API still authorizes every rollback.
    canWrite:
      me.scopes.includes("models:write") &&
      (me.applications.includes("*") || me.applications.includes(application)),
    diff,
  };
};

export const actions: Actions = {
  rollback: async ({ locals, request }) => {
    const form = await request.formData();
    const result = await rollback(
      (path, init) => mutate(locals, path, init),
      applicationOf(String(form.get("application") ?? "")),
      form,
    );
    return result.status === 200 ? result : fail(result.status, result);
  },
};
