# SDK conformance suite

Both SDKs must pass every case in `cases/`, so `check` and `batchCheck` behave
the same in TypeScript and Python. Each SDK has its own loader that starts a
local HTTP server, answers with the case's response and compares what the SDK
does with what the case expects.

| SDK | Loader | Run |
| --- | --- | --- |
| TypeScript | `sdks/typescript/src/conformance.test.ts` | `pnpm --filter @riz/sdk test` |
| Python | `sdks/python/tests/test_conformance.py` | `uv run pytest sdks/python` |

`pnpm --filter @riz/scripts test` checks the cases themselves against
`contracts/openapi.yaml`. Both are part of `make test` and CI.

## Case format

One JSON file per case. Every case uses application `crm`, bearer token
`svc-token` and, unless `client.timeoutMs` says otherwise, a 2000 ms timeout.

| Field | Meaning |
| --- | --- |
| `name` | The behavior under test. |
| `client.timeoutMs` | Optional timeout override. |
| `call` | `operation` (`check` or `batchCheck`), `endUserToken`, optionally `consistency`, and `action` + `resource` or `checks`. A check with `count: n` stands for n copies. |
| `expectRequest` | `method`, `path` and optionally `body` the server must receive. Omitted means the body is not asserted. |
| `response` | What the server sends: `status`, `headers`, `body` (a string is sent as is), `delayMs` before answering, or `drop: true` to close the connection. |
| `nonconformingResponse` | `true` when the response deliberately breaks the contract, to test how an SDK treats a misbehaving server. The contract test requires such a response to really fail validation. |
| `expect` | Either `result` (a subset of the decision, as camelCase JSON) or `error` (`type` plus any of `status`, `code`, `requestId`). |

The loader also asserts, for every case, that exactly one request arrives with
`Authorization: Bearer svc-token`, `Riz-End-User-Token` equal to
`call.endUserToken` and a JSON content type, and that no error message contains
either token.

## Adding a case

Add a JSON file, run both SDK suites and `pnpm --filter @riz/scripts test`. A
case that one SDK fails is a behavior difference to fix in that SDK, not a case
to bend.
