# Quickstart

From a fresh clone to your first allowed check, using the local stack. It uses dev-only
tokens (`deploy/fixtures`); never expose this stack.

Requires Docker, with ports 3000, 5432, 8080 and 8081 free.

## 1. Start riz

```sh
cp .env.example .env     # the placeholder passwords are fine locally
make up                  # postgres, openfga, api on :8080 (and a console on :3000)
curl localhost:8080/health/ready
```

Expect `{"status":"ok"}`.

## 2. Register an application

Every application gets its own isolated OpenFGA store and the base authorization model.

```sh
export RIZ=http://localhost:8080
APP=$(curl -sf -X POST $RIZ/v1/applications \
  -H 'authorization: Bearer dev-admin-token' -H 'content-type: application/json' \
  -d '{"name":"quickstart","environment":"prod"}' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
echo $APP
```

The ID is the name plus the environment (`quickstart-prod`). It must be unique, so use another
`name` if you run this twice.

## 3. Grant alice read access

The base model lets a viewer of a project read the project's documents. Make `alice` a
viewer of `project:p1`, and put `document:d1` in that project:

```sh
curl -sf -X POST $RIZ/v1/relationships \
  -H 'authorization: Bearer dev-admin-token' -H 'content-type: application/json' \
  -d "{\"application\":\"$APP\",\"relationships\":[
    {\"subject\":\"user:alice\",\"relation\":\"viewer\",\"object\":\"project:p1\"},
    {\"subject\":\"project:p1\",\"relation\":\"project\",\"object\":\"document:d1\"}]}"
```

An empty reply (`204`) means written. The change is in the audit log (`GET /v1/audit`).

## 4. Check

The workload (`dev-check-token`) asks on behalf of the end user (`dev-alice-token`, which
the fixture identity provider maps to alice):

```sh
curl -s -X POST $RIZ/v1/check \
  -H 'authorization: Bearer dev-check-token' \
  -H 'riz-end-user-token: dev-alice-token' -H 'content-type: application/json' \
  -d "{\"application\":\"$APP\",\"relation\":\"read\",\"object\":\"document:d1\"}"
```

The answer has `"status":"allow"`. Ask for `document:d2` and the status is `deny`.

## Dry run record

| Date | What was run | Result |
| --- | --- | --- |
| 2026-11-01 | Steps 2–4, exactly as written, against the API run from source on the host (fixture auth, throwaway Postgres and in-memory OpenFGA) | `d1` allow, `d2` deny, as above. |
| not yet | Step 1 (`make up`) and the whole page from a clean clone | **Unverified.** Ports 5432 and 3000 were in use on the machine, so the compose stack was not started. |

The acceptance bar for this page is a run of every step from a clean clone; add a row when
that is done, with the date and what you saw.

## Next

- Do the same from code: [`examples/fastapi`](../examples/fastapi/README.md),
  [`examples/express`](../examples/express/README.md), or the SDK snippets in the
  [README](../README.md#sdks).
- The console starts on :3000 but the compose file gives it no identity provider, so you
  cannot sign in locally; see [deploy/kubernetes](../deploy/kubernetes/README.md) for the
  settings it needs.
- Stop the stack with `make down`. To also wipe the Postgres volume, run
  `docker compose --env-file .env -f deploy/compose.yaml down -v`.
- Run it for real: [operations.md](operations.md) and [security.md](security.md).
