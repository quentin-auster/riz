import { error } from "@sveltejs/kit";
import { callApi } from "$lib/server/call";
import type { PageServerLoad } from "./$types";

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const load: PageServerLoad = async ({ locals, params }) => {
  // Checked before it is put in an API path.
  if (!ID.test(params.id)) error(404, "Application not found.");
  const [application, models] = await Promise.all([
    callApi<{
      id: string;
      name: string;
      environment: string;
      createdAt: string;
    }>(locals, `/v1/applications/${params.id}`),
    callApi<{ items: { id: string; createdAt: string; active: boolean }[] }>(
      locals,
      `/v1/models?application=${params.id}&limit=100`,
    ),
  ]);
  return {
    application,
    active: models.items.find((m) => m.active) ?? null,
    prior: models.items.filter((m) => !m.active),
  };
};
