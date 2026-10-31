import type { LayoutServerLoad } from "./$types";

// Only the subject is exposed to the page; the access token stays in locals.
export const load: LayoutServerLoad = ({ locals }) => ({
  subject: locals.session?.subject ?? null,
});
