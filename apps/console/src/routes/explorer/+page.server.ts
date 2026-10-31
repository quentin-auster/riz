import { fail } from "@sveltejs/kit";
import { mutate } from "$lib/server/call";
import { explore } from "$lib/server/explorer";
import type { Actions } from "./$types";

export const actions: Actions = {
  check: async ({ locals, request }) => {
    const form = await request.formData();
    const result = await explore(
      (path, init) => mutate(locals, path, init),
      form,
    );
    // The query is echoed back so a refusal leaves the form filled in.
    const query = Object.fromEntries(
      ["application", "principal", "relation", "object"].map((k) => [
        k,
        String(form.get(k) ?? ""),
      ]),
    );
    return result.status === 200
      ? { ...result, query }
      : fail(result.status, { ...result, query });
  },
};
