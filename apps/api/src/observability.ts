import type { IncomingMessage, ServerResponse } from "node:http";
import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { MeterProvider, type MetricReader } from "@opentelemetry/sdk-metrics";
import {
  BatchSpanProcessor,
  type SpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";

// Tracing and metrics are off unless configured, and the instruments below are then no-ops.
// Spans and metric attributes carry only fixed names, route templates, status codes and the
// request ID: never headers, query strings, bodies, tokens or user identities.

// The tracing API hands out proxies that start recording once a provider is registered; the
// metrics API does not, so instruments are created by registerMetrics and are absent until then.
const tracer = trace.getTracer("riz-api");

const SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

function createInstruments(provider: MeterProvider) {
  const meter = provider.getMeter("riz-api");
  return {
    requestDuration: meter.createHistogram("riz.http.server.duration", {
      unit: "s",
      description:
        "Request duration by route and status; its count is the request rate.",
      advice: { explicitBucketBoundaries: SECONDS },
    }),
    decisions: meter.createCounter("riz.check.decisions", {
      description: "Check outcomes (a batch counts each item).",
    }),
    openfgaDuration: meter.createHistogram("riz.openfga.duration", {
      unit: "s",
      description: "Time spent in OpenFGA calls.",
      advice: { explicitBucketBoundaries: SECONDS },
    }),
    batchSize: meter.createHistogram("riz.batch.size", {
      description: "Checks per batch request.",
      advice: { explicitBucketBoundaries: [1, 5, 10, 25, 50, 100] },
    }),
  };
}

let instruments: ReturnType<typeof createInstruments> | undefined;

const STATIC_ROUTES = new Set([
  "/health/live",
  "/health/ready",
  "/v1/me",
  "/v1/applications",
  "/v1/audit",
  "/v1/models",
  "/v1/models/rollback",
  "/v1/providers/databricks",
  "/v1/relationships",
  "/v1/workload-bindings",
  "/v1/check",
  "/v1/batch-check",
  "/v1/explorer/check",
]);

/**
 * The route template for a path, as a metric label. Anything else is "unmatched", so
 * callers (who can hit /v1/ paths before authenticating) cannot mint unbounded label values.
 * shortcut: a hand-kept list; a new route shows as "unmatched" until it is added here.
 */
export function routeOf(path: string): string {
  if (STATIC_ROUTES.has(path)) return path;
  if (/^\/v1\/applications\/[^/]+$/.test(path)) return "/v1/applications/{id}";
  if (/^\/v1\/models\/[^/]+$/.test(path)) return "/v1/models/{id}";
  return "unmatched";
}

/** Runs `run` inside a server span that continues the caller's W3C trace, if it sent one. */
export function observeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  info: { requestId: string; path: string },
  run: () => void,
): void {
  const route = routeOf(info.path);
  const method = req.method ?? "UNKNOWN";
  const parent = propagation.extract(context.active(), req.headers);
  const span = tracer.startSpan(
    `${method} ${route}`,
    {
      kind: SpanKind.SERVER,
      attributes: {
        "http.request.method": method,
        "http.route": route,
        "riz.request_id": info.requestId,
      },
    },
    parent,
  );
  const started = performance.now();
  res.once("close", () => {
    const status = res.statusCode;
    span.setAttribute("http.response.status_code", status);
    if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();
    instruments?.requestDuration.record((performance.now() - started) / 1000, {
      "http.request.method": method,
      "http.route": route,
      "http.response.status_code": status,
    });
  });
  context.with(trace.setSpan(parent, span), run);
}

/**
 * Runs an OpenFGA call under a client span and records its duration. Call `traceHeaders()`
 * from inside `fn` to hand this span's context to OpenFGA.
 */
export async function observeOpenFga<T>(
  operation: "check" | "batch_check",
  fn: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  const span = tracer.startSpan(`openfga.${operation}`, {
    kind: SpanKind.CLIENT,
    attributes: { "rpc.system": "openfga", "rpc.method": operation },
  });
  let outcome = "ok";
  try {
    return await context.with(trace.setSpan(context.active(), span), fn);
  } catch (err) {
    outcome = "error";
    // The error type only: error messages can quote request details.
    span.setAttribute(
      "error.type",
      err instanceof Error ? err.name : "unknown",
    );
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw err;
  } finally {
    span.end();
    instruments?.openfgaDuration.record((performance.now() - started) / 1000, {
      "rpc.method": operation,
      outcome,
    });
  }
}

/** W3C trace-context headers for the active span, to send on an outgoing request. */
export function traceHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  propagation.inject(context.active(), headers);
  return headers;
}

export function recordDecisions(statuses: Iterable<string>): void {
  for (const status of statuses) instruments?.decisions.add(1, { status });
}

export function recordBatchSize(size: number): void {
  instruments?.batchSize.record(size);
}

const resource = resourceFromAttributes({ "service.name": "riz-api" });

/** Installs the global tracer, W3C propagator and async context for `spanProcessors`. */
export function registerTracing(
  spanProcessors: SpanProcessor[],
): TracerProvider {
  const provider = new TracerProvider({ resource, spanProcessors });
  context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  );
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(provider);
  return provider;
}

export function registerMetrics(readers: MetricReader[]): MeterProvider {
  const provider = new MeterProvider({ resource, readers });
  instruments = createInstruments(provider);
  return provider;
}

/**
 * Turns on what the environment asks for:
 * - `OTEL_EXPORTER_OTLP_ENDPOINT` (standard OpenTelemetry variable): export traces over OTLP/HTTP.
 * - `RIZ_METRICS_PORT`: serve Prometheus metrics on a separate, unauthenticated port, bound to
 *   `RIZ_METRICS_HOST` (default 127.0.0.1). Never expose that port beyond the monitoring network.
 */
export function setupObservability(env: NodeJS.ProcessEnv): void {
  if (env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    registerTracing([
      new BatchSpanProcessor({ exporter: new OTLPTraceExporter() }),
    ]);
  }
  if (env.RIZ_METRICS_PORT) {
    const port = Number(env.RIZ_METRICS_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("RIZ_METRICS_PORT must be an integer from 1 to 65535");
    }
    registerMetrics([
      new PrometheusExporter({
        port,
        host: env.RIZ_METRICS_HOST || "127.0.0.1",
      }),
    ]);
  }
}
