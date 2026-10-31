import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { OpenFgaClient } from "@openfga/sdk";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace";
import type { createResolver } from "./checks/resolver.js";
import { checkRoutes } from "./checks/routes.js";
import { createCheckService } from "./checks/service.js";
import { registerMetrics, registerTracing, routeOf } from "./observability.js";
import { createApp } from "./server.js";

// No Postgres, Docker or OpenFGA: a stub HTTP server stands in for OpenFGA, and the
// OpenTelemetry providers export to memory.
const spans = new InMemorySpanExporter();
registerTracing([new SimpleSpanProcessor({ exporter: spans })]);
const metricsOut = new InMemoryMetricExporter(
  AggregationTemporality.CUMULATIVE,
);
const reader = new PeriodicExportingMetricReader({
  exporter: metricsOut,
  exportIntervalMillis: 3_600_000,
});
registerMetrics([reader]);

const ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CALLER_TRACE = "0af7651916cd43dd8448eb211c80319c";
const CALLER_SPAN = "b7ad6b7169203331";

function listen(server: Server) {
  return new Promise<number>((resolve) =>
    server.listen(0, () => resolve((server.address() as AddressInfo).port)),
  );
}

/** Runs riz over a fake OpenFGA that allows everything and records the traceparent it gets. */
async function withRiz(
  fn: (ctx: {
    post: (path: string, body: unknown, auth?: string) => Promise<number>;
    upstreamTraceparents: (string | undefined)[];
  }) => Promise<void>,
) {
  const upstreamTraceparents: (string | undefined)[] = [];
  const upstream = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    upstreamTraceparents.push(req.headers.traceparent as string | undefined);
    const body = JSON.parse(raw) as { checks?: { correlation_id: string }[] };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        body.checks
          ? {
              result: Object.fromEntries(
                body.checks.map((c) => [c.correlation_id, { allowed: true }]),
              ),
            }
          : { allowed: true },
      ),
    );
  });
  const upstreamPort = await listen(upstream);
  const resolver = {
    clientFor: async () =>
      new OpenFgaClient({
        apiUrl: `http://127.0.0.1:${upstreamPort}`,
        storeId: ULID,
        authorizationModelId: ULID,
      }),
  } as unknown as ReturnType<typeof createResolver>;
  const riz = createApp({
    readiness: async () => [],
    log: () => {},
    authenticate: (h) =>
      h === "Bearer svc-token"
        ? { subject: "svc", scopes: ["check"], applications: ["*"] }
        : null,
    routes: checkRoutes({
      service: createCheckService({ resolver, timeoutMs: 2000 }),
      verifyEndUser: () => "alice",
      maxBatchSize: 10,
    }),
  });
  const port = await listen(riz);
  try {
    await fn({
      upstreamTraceparents,
      post: async (path, body, auth = "Bearer svc-token") =>
        (
          await fetch(`http://127.0.0.1:${port}${path}`, {
            method: "POST",
            headers: {
              authorization: auth,
              "content-type": "application/json",
              "riz-end-user-token": "alice-token",
              traceparent: `00-${CALLER_TRACE}-${CALLER_SPAN}-01`,
            },
            body: JSON.stringify(body),
          })
        ).status,
    });
  } finally {
    riz.closeAllConnections();
    riz.close();
    upstream.closeAllConnections();
    upstream.close();
  }
}

async function until(done: () => boolean) {
  for (let i = 0; i < 100 && !done(); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(done(), "timed out waiting for telemetry");
}

test("one check is a single trace across the caller, riz and the OpenFGA request", async () => {
  spans.reset();
  await withRiz(async ({ post, upstreamTraceparents }) => {
    assert.equal(
      await post("/v1/check?secret=hunter2", {
        application: "crm-prod",
        relation: "read",
        object: "document:d1",
      }),
      200,
    );
    await until(() => spans.getFinishedSpans().length >= 2);

    const finished = spans.getFinishedSpans();
    const server = finished.find((s) => s.name === "POST /v1/check");
    const client = finished.find((s) => s.name === "openfga.check");
    assert.ok(server && client, "server and OpenFGA spans exist");
    assert.equal(server.spanContext().traceId, CALLER_TRACE);
    assert.equal(server.parentSpanContext?.spanId, CALLER_SPAN);
    assert.equal(client.spanContext().traceId, CALLER_TRACE);
    assert.equal(client.parentSpanContext?.spanId, server.spanContext().spanId);
    assert.deepEqual(upstreamTraceparents, [
      `00-${CALLER_TRACE}-${client.spanContext().spanId}-01`,
    ]);

    const everything = JSON.stringify(
      finished.map((s) => [s.name, s.attributes, s.events, s.links]),
    );
    for (const secret of ["svc-token", "alice", "hunter2", "Bearer"]) {
      assert.ok(!everything.includes(secret), `span data leaks ${secret}`);
    }
  });
});

type Point = { attributes: Record<string, unknown>; value: unknown };

async function pointCount(
  name: string,
  attributes: Record<string, unknown>,
): Promise<number> {
  await reader.forceFlush();
  const point = (
    metricsOut
      .getMetrics()
      .at(-1)
      ?.scopeMetrics.flatMap((s) => s.metrics)
      .find((m) => m.descriptor.name === name)?.dataPoints as
      | Point[]
      | undefined
  )?.find((p) =>
    Object.entries(attributes).every(([k, v]) => p.attributes[k] === v),
  );
  const value = point?.value;
  if (typeof value === "number") return value;
  return (value as { count: number } | undefined)?.count ?? 0;
}

test("metrics count requests by route, decisions, OpenFGA calls and batch sizes", async () => {
  const probes = {
    served: [
      "riz.http.server.duration",
      { "http.route": "/v1/batch-check", "http.response.status_code": 200 },
    ],
    unmatched: [
      "riz.http.server.duration",
      { "http.route": "unmatched", "http.response.status_code": 401 },
    ],
    allow: ["riz.check.decisions", { status: "allow" }],
    fga: [
      "riz.openfga.duration",
      { "rpc.method": "batch_check", outcome: "ok" },
    ],
    sizes: ["riz.batch.size", {}],
  } as const;
  const read = async () =>
    Object.fromEntries(
      await Promise.all(
        Object.entries(probes).map(async ([k, [n, a]]) => [
          k,
          await pointCount(n, a),
        ]),
      ),
    ) as Record<keyof typeof probes, number>;

  const before = await read();
  await withRiz(async ({ post }) => {
    const checks = ["a", "b", "c"].map((correlationId) => ({
      correlationId,
      relation: "read",
      object: "document:d1",
    }));
    assert.equal(
      await post("/v1/batch-check", { application: "crm-prod", checks }),
      200,
    );
    assert.equal(
      await post("/v1/some-random-path-1234", {}, "Bearer nope"),
      401,
    );
  });
  // The request histogram is recorded when the response closes, just after the client sees it.
  let after = await read();
  for (let i = 0; i < 100 && after.unmatched === before.unmatched; i++) {
    await new Promise((r) => setTimeout(r, 10));
    after = await read();
  }
  assert.equal(after.served - before.served, 1);
  assert.equal(after.unmatched - before.unmatched, 1);
  assert.equal(after.allow - before.allow, 3);
  assert.equal(after.fga - before.fga, 1);
  assert.equal(after.sizes - before.sizes, 1);

  const routes = new Set(
    metricsOut
      .getMetrics()
      .at(-1)
      ?.scopeMetrics.flatMap((s) => s.metrics)
      .filter((m) => m.descriptor.name === "riz.http.server.duration")
      .flatMap((m) =>
        (m.dataPoints as Point[]).map((p) => p.attributes["http.route"]),
      ),
  );
  assert.ok(
    !routes.has("/v1/some-random-path-1234"),
    "raw paths must not become labels",
  );
});

test("route labels are templates, and unknown paths share one label", () => {
  assert.equal(routeOf("/v1/check"), "/v1/check");
  assert.equal(routeOf("/v1/applications/crm-prod"), "/v1/applications/{id}");
  assert.equal(routeOf("/v1/models/some-id"), "/v1/models/{id}");
  assert.equal(routeOf("/v1/models/rollback"), "/v1/models/rollback");
  for (const path of [
    "/v1/nope",
    "/",
    "/v1/applications/a/b",
    "/v1/check/extra",
  ]) {
    assert.equal(routeOf(path), "unmatched", path);
  }
});
