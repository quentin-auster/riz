export const FILTERS = [
  "application",
  "actor",
  "action",
  "from",
  "to",
] as const;

export type AuditFilters = Record<(typeof FILTERS)[number], string>;

/**
 * The API query for the page's filters. Blank filters are dropped; `from` and `to` are
 * entered as UTC date-times. A bad date is reported here instead of becoming an API 400.
 */
export function auditQuery(
  params: URLSearchParams,
): { filters: AuditFilters; query: URLSearchParams } | { error: string } {
  const filters = Object.fromEntries(
    FILTERS.map((k) => [k, params.get(k)?.trim() ?? ""]),
  ) as AuditFilters;
  const query = new URLSearchParams({ limit: "50" });
  for (const k of ["application", "actor", "action"] as const) {
    if (filters[k]) query.set(k, filters[k]);
  }
  for (const k of ["from", "to"] as const) {
    if (!filters[k]) continue;
    // shortcut: UTC only, no per-user time zone; add one when operators ask for local time.
    const time = new Date(`${filters[k]}Z`);
    if (Number.isNaN(time.getTime())) {
      return { error: `${k} is not a valid date and time.` };
    }
    query.set(k, time.toISOString());
  }
  const cursor = params.get("cursor");
  if (cursor) query.set("cursor", cursor);
  return { filters, query };
}
