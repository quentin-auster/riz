import { callApi } from "$lib/server/call";
import type { PageServerLoad } from "./$types";

interface Application {
  id: string;
  name: string;
  environment: string;
  createdAt: string;
}

// The API returns only the applications this user may administer or audit.
export const load: PageServerLoad = async ({ locals, url }) => {
  const q = url.searchParams.get("q")?.trim().toLowerCase() ?? "";
  const cursor = url.searchParams.get("cursor");
  const page = await callApi<{ items: Application[]; nextCursor?: string }>(
    locals,
    `/v1/applications?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
  );
  return {
    q,
    // shortcut: search filters the loaded page only; add server-side search to the API
    // once a deployment has more than 100 applications.
    items: q
      ? page.items.filter(
          (a) => a.id.includes(q) || a.name.toLowerCase().includes(q),
        )
      : page.items,
    nextCursor: page.nextCursor ?? null,
  };
};
