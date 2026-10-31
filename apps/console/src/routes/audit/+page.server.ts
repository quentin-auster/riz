import { auditQuery } from "$lib/server/audit";
import { callApi } from "$lib/server/call";
import type { PageServerLoad } from "./$types";

interface AuditEvent {
  id: string;
  time: string;
  actor: string;
  action: string;
  application?: string;
  outcome: string;
  requestId?: string;
}

export const load: PageServerLoad = async ({ locals, url }) => {
  const q = auditQuery(url.searchParams);
  if ("error" in q) {
    return {
      filters: { application: "", actor: "", action: "", from: "", to: "" },
      items: [] as AuditEvent[],
      nextCursor: null,
      filterError: q.error,
    };
  }
  const page = await callApi<{ items: AuditEvent[]; nextCursor?: string }>(
    locals,
    `/v1/audit?${q.query}`,
  );
  return {
    filters: q.filters,
    items: page.items,
    nextCursor: page.nextCursor ?? null,
    filterError: null,
  };
};
