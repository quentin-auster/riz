# 0008 — Metrics and tracing

## Decision

The API emits OpenTelemetry traces and Prometheus metrics. Both are off unless configured.

1. **Tracing** is on when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (the standard variable;
   OTLP/HTTP). A request becomes a server span that continues the caller's W3C
   `traceparent`, if any. Each OpenFGA call is a child client span, and riz sends its
   `traceparent` on the OpenFGA request, so OpenFGA's own spans (`OPENFGA_TRACE_ENABLED`)
   join the same trace.
2. **Metrics** are on when `RIZ_METRICS_PORT` is set. They are served on that separate
   port, bound to `RIZ_METRICS_HOST` (default `127.0.0.1`). The endpoint is
   **unauthenticated**: keep it on the monitoring network and never publish it.
3. **Nothing sensitive is recorded.** Spans and metric labels hold only fixed names, route
   templates, status codes and the request ID: never headers, query strings, bodies, tokens
   or user identities. An OpenFGA error is recorded by type name only.
4. **Route labels are an allowlist.** Callers can hit `/v1/` paths before authenticating, so
   a raw path as a label would let them mint unbounded series. Unknown paths are
   `unmatched`.
5. **Explorer checks are not decisions.** They are traced and timed, but not counted in
   `riz.check.decisions`.

| Metric | Type | Labels |
| --- | --- | --- |
| `riz.http.server.duration` (s) | histogram | `http.request.method`, `http.route`, `http.response.status_code` |
| `riz.check.decisions` | counter | `status` (`allow`, `deny`, `indeterminate`); a batch counts each item |
| `riz.openfga.duration` (s) | histogram | `rpc.method` (`check`, `batch_check`), `outcome` (`ok`, `error`) |
| `riz.batch.size` | histogram | none |

Request rate and error rate come from the duration histogram's count. Prometheus exposes
these with dots turned into underscores.

## Local stack

`docker compose --profile observability up` adds Jaeger and Prometheus (images pinned in
`deploy/compose.yaml`; Prometheus scrapes `api:9464`). Set in `.env`:
`OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318`, `RIZ_METRICS_PORT=9464`, and optionally
`RIZ_OPENFGA_TRACE=true`. The default stack is unchanged.

## Consequences and limits

- No OpenTelemetry Collector: Jaeger takes OTLP directly. shortcut: add a collector when
  fan-out, sampling or tail processing is needed.
- Unit tests prove the span tree, `traceparent` propagation, metric values and the absence of
  tokens against a stub upstream. The compose profile was validated with `docker compose
  config` only. Live Jaeger and Prometheus ingestion, and OpenFGA spans joining riz's trace,
  are **unverified** until the profile is run.
- The route allowlist is hand-kept; a new route reads `unmatched` until it is added to
  `routeOf`.
- Only the API is instrumented; the console and SDKs are not.
