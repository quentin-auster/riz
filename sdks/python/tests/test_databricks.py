"""Contract tests against a mocked Databricks Statement Execution API.

The real Unity Catalog test at the end is UNVERIFIED: it only runs when pointed at an
authorized workspace, and has not been run.
"""

import asyncio
import json
import os
import traceback
from collections.abc import Callable
from typing import Any

import httpx
import pytest
from riz.databricks import (
    Databricks,
    DatabricksDeniedError,
    DatabricksError,
    MissingUserCredentialError,
    user_token_from_headers,
)

HOST = "dbc-1234.cloud.databricks.com"
USER_TOKEN = "user-delegated-token"

OK = {
    "statement_id": "st-1",
    "status": {"state": "SUCCEEDED"},
    "manifest": {"schema": {"columns": [{"name": "id"}, {"name": "name"}]}},
    "result": {"data_array": [["1", "anne"], ["2", None]]},
}


def _run(
    handler: Callable[[httpx.Request], httpx.Response], **call: Any
) -> tuple[Any, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    async def go() -> Any:
        async with Databricks(HOST, "wh1", transport=httpx.MockTransport(record)) as db:
            return await db.query("SELECT 1", **call)

    return asyncio.run(go()), seen


def test_runs_the_statement_as_the_user_and_returns_rows() -> None:
    result, seen = _run(lambda _: httpx.Response(200, json=OK), user_token=USER_TOKEN)

    assert result.columns == ["id", "name"]
    assert result.rows == [["1", "anne"], ["2", None]]
    (request,) = seen
    assert str(request.url) == f"https://{HOST}/api/2.0/sql/statements"
    assert request.headers["authorization"] == f"Bearer {USER_TOKEN}"
    sent = json.loads(request.content)
    assert sent["warehouse_id"] == "wh1"
    assert sent["statement"] == "SELECT 1"
    assert sent["on_wait_timeout"] == "CANCEL"


def test_sends_named_parameters() -> None:
    _, seen = _run(
        lambda _: httpx.Response(200, json=OK),
        user_token=USER_TOKEN,
        parameters={"owner": "anne"},
    )

    assert json.loads(seen[0].content)["parameters"] == [{"name": "owner", "value": "anne"}]


@pytest.mark.parametrize("token", [None, ""])
def test_refuses_to_query_without_a_user_token_and_sends_nothing(token: str | None) -> None:
    seen: list[httpx.Request] = []

    async def go() -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200, json=OK)

        async with Databricks(HOST, "wh1", transport=httpx.MockTransport(handler)) as db:
            await db.query("SELECT 1", user_token=token)

    with pytest.raises(MissingUserCredentialError):
        asyncio.run(go())
    assert seen == []


def test_reads_the_token_databricks_apps_forwards_whatever_the_header_case() -> None:
    assert user_token_from_headers({"X-Forwarded-Access-Token": USER_TOKEN}) == USER_TOKEN


@pytest.mark.parametrize(
    "headers", [{}, {"x-forwarded-access-token": ""}, {"authorization": "Bearer svc"}]
)
def test_does_not_fall_back_to_other_headers_when_the_forwarded_token_is_missing(
    headers: dict[str, str],
) -> None:
    with pytest.raises(MissingUserCredentialError):
        user_token_from_headers(headers)


def test_a_user_without_a_unity_catalog_grant_is_denied_by_databricks() -> None:
    denied = {
        **OK,
        "status": {
            "state": "FAILED",
            "error": {
                "error_code": "PERMISSION_DENIED",
                "message": "no SELECT on main.hr.salaries",
            },
        },
    }

    with pytest.raises(DatabricksDeniedError) as raised:
        _run(lambda _: httpx.Response(200, json=denied), user_token=USER_TOKEN)

    assert raised.value.code == "PERMISSION_DENIED"


@pytest.mark.parametrize("status", [401, 403])
def test_a_rejected_or_expired_token_is_a_denial_not_an_empty_result(status: int) -> None:
    with pytest.raises(DatabricksDeniedError):
        _run(
            lambda _: httpx.Response(status, json={"error_code": "X", "message": "nope"}),
            user_token=USER_TOKEN,
        )


def test_other_failures_are_errors_not_denials() -> None:
    with pytest.raises(DatabricksError) as raised:
        _run(lambda _: httpx.Response(500, text="boom"), user_token=USER_TOKEN)

    assert not isinstance(raised.value, DatabricksDeniedError)
    assert raised.value.status == 500


def test_a_cancelled_statement_is_an_error() -> None:
    cancelled = {**OK, "status": {"state": "CANCELED"}}

    with pytest.raises(DatabricksError):
        _run(lambda _: httpx.Response(200, json=cancelled), user_token=USER_TOKEN)


def test_a_partial_result_is_an_error_not_a_short_answer() -> None:
    chunked = {**OK, "result": {"data_array": [["1", "anne"]], "next_chunk_index": 1}}

    with pytest.raises(DatabricksError) as raised:
        _run(lambda _: httpx.Response(200, json=chunked), user_token=USER_TOKEN)

    assert raised.value.code == "result_too_large"


def test_the_token_does_not_follow_a_redirect() -> None:
    seen: list[httpx.Request] = []

    def redirect(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(302, headers={"location": "https://evil.example.com/steal"})

    with pytest.raises(DatabricksError):
        _run(redirect, user_token=USER_TOKEN)

    assert [r.url.host for r in seen] == [HOST]


@pytest.mark.parametrize(
    "host",
    [
        "https://" + HOST,
        f"{HOST}/path",
        f"{HOST}:8443",
        f"user:pw@{HOST}",
        "localhost",
        "EVIL.example.com",
        "",
    ],
)
def test_rejects_a_workspace_host_that_could_receive_the_token_elsewhere(host: str) -> None:
    with pytest.raises(ValueError):
        Databricks(host, "wh1")


def test_a_transport_failure_does_not_carry_the_user_token() -> None:
    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(f"failed with {request.headers['authorization']}")

    with pytest.raises(DatabricksError) as raised:
        _run(boom, user_token=USER_TOKEN)

    assert USER_TOKEN not in "".join(traceback.format_exception(raised.value))
    # The httpx error quotes the header, so it must not survive on the exception either.
    assert raised.value.__context__ is None and raised.value.__cause__ is None


@pytest.mark.skipif(
    not all(
        os.environ.get(v)
        for v in (
            "RIZ_DATABRICKS_HOST",
            "RIZ_DATABRICKS_WAREHOUSE_ID",
            "RIZ_DATABRICKS_USER_TOKEN",
            "RIZ_DATABRICKS_DENIED_TABLE",
        )
    ),
    reason="UNVERIFIED: needs an authorized workspace, a user token, and a table that user cannot read",
)
def test_unverified_real_unity_catalog_denies_a_user_without_a_grant() -> None:
    async def go() -> None:
        async with Databricks(
            os.environ["RIZ_DATABRICKS_HOST"], os.environ["RIZ_DATABRICKS_WAREHOUSE_ID"]
        ) as db:
            token = os.environ["RIZ_DATABRICKS_USER_TOKEN"]
            assert (await db.query("SELECT 1", user_token=token)).rows == [["1"]]
            with pytest.raises(DatabricksDeniedError):
                await db.query(
                    f"SELECT * FROM {os.environ['RIZ_DATABRICKS_DENIED_TABLE']} LIMIT 1",
                    user_token=token,
                )

    asyncio.run(go())
