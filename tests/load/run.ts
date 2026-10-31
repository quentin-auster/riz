import { randomBytes } from "node:crypto";
import autocannon from "autocannon";

// Load run against a running stack: RIZ_API_URL=http://localhost:8080 OPENFGA_API_URL=http://localhost:8081
//   pnpm --filter @riz/load load
// Prints a markdown table. Fixture tokens are the dev-only values in deploy/fixtures.
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
const api = required("RIZ_API_URL");
const openfga = required("OPENFGA_API_URL");
const seconds = Number(process.env.LOAD_SECONDS ?? 10);
const steps = (process.env.LOAD_CONNECTIONS ?? "1,4,16,64")
  .split(",")
  .map(Number);

const riz = (token: string) => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
});
const CHECK_HEADERS = {
  ...riz("dev-check-token"),
  "riz-end-user-token": "dev-alice-token",
};

async function json(res: Response) {
  if (!res.ok) throw new Error(`${res.url}: ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

const name = `ld${randomBytes(6).toString("hex")}`;
const created = await json(
  await fetch(`${api}/v1/applications`, {
    method: "POST",
    headers: riz("dev-admin-token"),
    body: JSON.stringify({ name, environment: "prod" }),
  }),
);
const app = created.id as string;
const granted = await fetch(`${api}/v1/relationships`, {
  method: "POST",
  headers: riz("dev-admin-token"),
  body: JSON.stringify({
    application: app,
    relationships: [
      { subject: "project:p1", relation: "project", object: "document:d1" },
      { subject: "user:alice", relation: "viewer", object: "project:p1" },
    ],
  }),
});
if (granted.status !== 204)
  throw new Error(`seeding failed: ${granted.status}`);

const { stores } = (await json(
  await fetch(`${openfga}/stores?name=${app}`),
)) as {
  stores: { id: string }[];
};
const storeId = stores[0]?.id;
if (!storeId) throw new Error("store not found");

const checkBody = (object: string) =>
  JSON.stringify({ application: app, relation: "read", object });
const batchBody = JSON.stringify({
  application: app,
  checks: Array.from({ length: 10 }, (_, i) => ({
    correlationId: `c${i}`,
    relation: "read",
    object: i % 2 ? "document:d1" : "document:d2",
  })),
});
const post = (url: string, headers: Record<string, string>, body: string) => ({
  method: "POST" as const,
  path: new URL(url).pathname,
  headers,
  body,
});

// Half the checks allow and half deny, as a permission-gated UI would see.
const single = [
  post(`${api}/v1/check`, CHECK_HEADERS, checkBody("document:d1")),
  post(`${api}/v1/check`, CHECK_HEADERS, checkBody("document:d2")),
];
const batch = post(`${api}/v1/batch-check`, CHECK_HEADERS, batchBody);
const scenarios: Record<
  string,
  { base: string; requests: ReturnType<typeof post>[] }
> = {
  "check (riz)": { base: api, requests: single },
  "batch-check x10 (riz)": { base: api, requests: [batch] },
  "mixed 9:1 (riz)": {
    base: api,
    requests: [
      ...single,
      ...single,
      ...single,
      ...single,
      ...single,
      ...single,
      ...single,
      ...single,
      ...single,
      batch,
    ],
  },
  "check (OpenFGA direct)": {
    base: openfga,
    requests: ["document:d1", "document:d2"].map((object) =>
      post(
        `${openfga}/stores/${storeId}/check`,
        { "content-type": "application/json" },
        JSON.stringify({
          tuple_key: { user: "user:alice", relation: "read", object },
        }),
      ),
    ),
  },
};

console.log(
  `| scenario | connections | req/s | p50 ms | p97.5 ms | p99 ms | max ms | failed |`,
);
console.log(`| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`);
for (const [label, { base, requests }] of Object.entries(scenarios)) {
  if (!label.includes(process.env.LOAD_ONLY ?? "")) continue;
  for (const connections of steps) {
    const r = await autocannon({
      url: base,
      connections,
      duration: seconds,
      requests,
    });
    const failed = r.errors + r.timeouts + r.non2xx;
    console.log(
      `| ${label} | ${connections} | ${Math.round(r.requests.average)} | ${r.latency.p50} | ${r.latency.p97_5} | ${r.latency.p99} | ${r.latency.max} | ${failed} |`,
    );
  }
}
