# Load test report (RIZ-035)

Question: where does a check spend its time, and is a cache (RIZ-036) justified?

## Reproduce

Needs a running stack (Postgres, OpenFGA, the API). Fixture tokens are the dev-only values.

```
RIZ_API_URL=http://localhost:8080 OPENFGA_API_URL=http://localhost:8081 pnpm --filter @riz/load load
```

`tests/load/run.ts` registers a fresh application, seeds one allow and one deny, then drives
[autocannon 8.0.0](https://github.com/mcollina/autocannon) for 10 s at 1, 4, 16 and 64
connections (`LOAD_SECONDS`, `LOAD_CONNECTIONS`, `LOAD_ONLY` to narrow) over four scenarios:
`check` (half allow, half deny), `batch-check` of 10, a 9:1 mix of the two, and the same
check sent straight to OpenFGA. A request that is not 2xx counts as failed. autocannon
reports p97.5, not p95, so that column replaces it.

## Environment

One Apple M4 laptop (10 cores, 16 GB). The API ran as a single local Node 22 process (tsx),
Postgres on a throwaway container, OpenFGA v1.10.2 in Docker Desktop on the Postgres
datastore, reached through Docker's published port. Load generator on the same machine.
**These are laptop numbers for comparing layers, not sizing figures.**

## Results

riz, one process (run 2; OpenFGA freshly restarted before it):

| scenario | connections | req/s | p50 ms | p97.5 ms | p99 ms | max ms | failed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| check | 1 | 303 | 2 | 9 | 13 | 41 | 0 |
| check | 4 | 404 | 8 | 24 | 33 | 93 | 0 |
| check | 16 | 328 | 40 | 131 | 170 | 258 | 0 |
| check | 64 | 220 | 209 | 905 | 1103 | 1397 | 0 |
| batch-check x10 | 1 | 114 | 7 | 21 | 29 | 873 | 0 |
| batch-check x10 | 4 | 355 | 9 | 33 | 41 | 99 | 0 |
| batch-check x10 | 16 | 385 | 29 | 154 | 234 | 393 | 0 |
| batch-check x10 | 64 | 380 | 144 | 486 | 622 | 718 | 0 |
| mixed 9:1 | 1 | 158 | 5 | 16 | 22 | 146 | 0 |
| mixed 9:1 | 4 | 588 | 5 | 17 | 22 | 104 | 0 |
| mixed 9:1 | 16 | 466 | 22 | 118 | 237 | 396 | 0 |
| mixed 9:1 | 64 | 373 | 141 | 465 | 523 | 784 | 0 |

The same checks sent directly to OpenFGA, measured separately on a freshly restarted instance:

| scenario | connections | req/s | p50 ms | p97.5 ms | p99 ms | max ms | failed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| check (OpenFGA direct) | 1 | 1432 | 0 | 1 | 2 | 18 | 0 |
| check (OpenFGA direct) | 4 | 2454 | 1 | 6 | 8 | 45 | 0 |
| check (OpenFGA direct) | 16 | 1527 | 7 | 31 | 40 | 93 | 0 |
| check (OpenFGA direct) | 64 | 3024 | 17 | 55 | 79 | 213 | 0 |

An earlier full run on the same machine peaked higher for riz (check 732 req/s at 16
connections, p99 59 ms; batch 770 req/s) and then degraded. Run-to-run variance is large:
treat figures as ±2x.

## What it shows

- **Saturation.** One riz process tops out around 400–750 req/s for single checks, at 4–16
  connections. Beyond that, throughput does not rise and latency climbs (check p99 above 1 s
  at 64 connections in run 2). No request failed in any step.
- **riz, not OpenFGA, is the slower layer in this setup.** Through the same OpenFGA, checks
  sent directly ran at 1.4–3 k req/s with p50 0–17 ms, several times what riz sustained.
  riz adds one Postgres lookup per request (the application's store and pinned model,
  `checks/resolver.ts`) and builds a new OpenFGA client per request. That fits the gap but
  was not profiled, so it is a likely cause, not a proven one.
- **A batch of 10 costs about the same as one check** at equal connection counts, so batching
  is the cheap way to ask many questions.

## Limits of this measurement

- OpenFGA's host-published port stopped answering after sustained load, with OpenFGA itself
  idle, until the container was restarted. That is probably Docker Desktop's port forwarding,
  not OpenFGA. It also means the first direct-OpenFGA attempt measured nothing, and riz's
  numbers include that forwarding path. A Linux run (CI or a server) is needed before
  trusting absolute figures. **Unverified.**
- Identical requests repeat, so OpenFGA's own result caching may flatter the direct numbers.
  A realistic mix would draw from many users and objects.
- One application, two tuples, one API process, one machine for generator and server.
- Multi-replica scaling was not measured (RIZ-034 proves equivalence, not throughput).

## Recommendation for RIZ-036

A cache of the **application binding** (application to store and pinned model) is worth
building: it removes a database round trip from every check and is the largest piece of
riz's own work visible here. Re-measure after it, on Linux, before going further.

A cache of **decisions** is not justified by this data and would delay revocation; do not
build it unless a Linux run with a realistic user/object mix shows OpenFGA itself saturating.
