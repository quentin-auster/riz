# Databricks example: riz permission plus Unity Catalog

`app.py` serves a report only when **both** agree, for the same user:

1. riz allows `read` on `report:<name>` for this application (app-level permission).
2. Databricks lets that user's own token read the table behind it (Unity Catalog).

A user with no Unity Catalog grant is refused by Databricks even when riz allows. riz never
holds, copies or checks Unity Catalog grants (ADR 0007).

## Status

| What | State |
| --- | --- |
| The flow against a local riz stand-in and a mocked Databricks (`tests/conformance/databricks/`, runs in CI) | Passing |
| Against a real workspace and real Unity Catalog | **Unverified.** Not run; no result is recorded here. |
| riz accepting a Databricks-issued user token as its end-user token | **Unverified.** `app.py` passes the forwarded Databricks token to riz as the end-user token, so riz must be configured to trust that token's issuer. This has not been tried. |

## Run the mocked flow

    uv run pytest tests/conformance/databricks

## Runbook for a real workspace

You need a workspace you are authorized to use, a SQL warehouse, a table, and two users:
one with `SELECT` on the table and one without. Do not use production data.

1. Start riz (`make up`) and register an application. Bind `report:sales` for the
   application with a `read` relationship for the first user (and, to see the
   "riz allows, Databricks denies" case, for the second).
2. Optionally store the workspace settings with `PUT /v1/providers/databricks`
   (`{"application": ..., "config": {"workspaceHost": ..., "warehouseId": ...}}`). The
   example does not read them back: it takes the host and warehouse from the environment
   variables in step 4, and no SDK method fetches the stored settings yet.
3. Point `REPORTS["sales"]` in `app.py` at your table.
4. Get a user token for each user (OAuth U2M, for example `databricks auth token`) and run:

       RIZ_API_URL=... RIZ_WORKLOAD_TOKEN=... RIZ_APPLICATION=... \
       RIZ_DATABRICKS_HOST=... RIZ_DATABRICKS_WAREHOUSE_ID=... \
       RIZ_USER_TOKEN=<that user's token> \
       uv run python examples/databricks/app.py sales

5. Expected, if everything behaves as designed:
   - user with riz grant and `SELECT`: `200` with rows;
   - user with riz grant but no `SELECT`: `403 denied by databricks`;
   - user without riz grant: `403 denied by riz`, and no query reaches Databricks.

The SDK-level real tests are `sdks/python/tests/test_databricks.py` and
`sdks/typescript/tests/databricks.test.ts`; they skip as unverified unless
`RIZ_DATABRICKS_HOST`, `RIZ_DATABRICKS_WAREHOUSE_ID`, `RIZ_DATABRICKS_USER_TOKEN` and
`RIZ_DATABRICKS_DENIED_TABLE` (a table that user cannot read) are set. Record any real run
in the table above with the date and what you saw; do not record results you did not observe.
