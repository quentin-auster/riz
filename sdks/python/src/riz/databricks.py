"""Run SQL on Databricks as the signed-in user (ADR 0007).

Unity Catalog decides what the user may read. The user's own delegated token is the only
credential this module sends; there is no service-principal or shared-token fallback.
"""

import re
from collections.abc import Mapping
from dataclasses import dataclass

import httpx

from riz.client import RizError

# Databricks Apps forwards the signed-in user's token in this header.
FORWARDED_TOKEN_HEADER = "x-forwarded-access-token"

# The same shape the riz API accepts: a bare lower-case host, so no scheme, port, path or
# userinfo rides along. shortcut: any DNS name passes, so the caller must trust where the
# host comes from; restrict to Databricks suffixes or an allow-list if it is ever untrusted.
_HOST = re.compile(
    r"^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$"
)
_DENIED_CODES = {"PERMISSION_DENIED", "UNAUTHENTICATED"}


class MissingUserCredentialError(RizError):
    """No delegated user token was available. Nothing was sent to Databricks."""


class DatabricksError(RizError):
    """Databricks did not return a result."""

    def __init__(self, status: int, code: str | None, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code


class DatabricksDeniedError(DatabricksError):
    """Databricks refused the user: no Unity Catalog grant, or a bad or expired token."""


@dataclass(frozen=True)
class QueryResult:
    statement_id: str
    columns: list[str]
    # Values arrive as strings (or None for SQL NULL), as the JSON_ARRAY format returns them.
    rows: list[list[str | None]]


def user_token_from_headers(headers: Mapping[str, str]) -> str:
    """The forwarded user token from a request's headers, matched case-insensitively."""
    for name, value in headers.items():
        if name.lower() == FORWARDED_TOKEN_HEADER and value:
            return value
    raise MissingUserCredentialError(
        f"no {FORWARDED_TOKEN_HEADER} header; refusing to query without the user's credential"
    )


def _error(status: int, code: str | None, message: str) -> DatabricksError:
    denied = status in (401, 403) or code in _DENIED_CODES
    return (DatabricksDeniedError if denied else DatabricksError)(status, code, message)


class Databricks:
    """Async Statement Execution API client for one workspace and SQL warehouse.

    shortcut: statements wait server-side up to `wait_seconds` (max 50) and are cancelled
    after that, and only the first inline chunk is read (a larger result raises); upgrade to
    polling and chunk fetching when a caller needs longer queries or bigger results.
    """

    def __init__(
        self,
        workspace_host: str,
        warehouse_id: str,
        wait_seconds: int = 30,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        if not _HOST.fullmatch(workspace_host):
            raise ValueError(
                "workspace_host must be a bare host name, such as dbc-1.cloud.databricks.com"
            )
        if not 5 <= wait_seconds <= 50:
            raise ValueError("wait_seconds must be 5 to 50")
        self._warehouse_id = warehouse_id
        self._wait_seconds = wait_seconds
        self._http = httpx.AsyncClient(
            base_url=f"https://{workspace_host}",
            transport=transport,
            timeout=wait_seconds + 10,
            # The user's token must not follow a redirect to another host.
            follow_redirects=False,
        )

    async def __aenter__(self) -> "Databricks":
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        await self._http.aclose()

    async def query(
        self,
        statement: str,
        *,
        user_token: str | None,
        parameters: Mapping[str, str] | None = None,
    ) -> QueryResult:
        """Runs `statement` as the user. Raises MissingUserCredentialError without a token,
        and DatabricksDeniedError when Databricks refuses the user."""
        if not user_token:
            raise MissingUserCredentialError(
                "no user token; refusing to query without the user's credential"
            )
        payload: dict[str, object] = {
            "warehouse_id": self._warehouse_id,
            "statement": statement,
            "wait_timeout": f"{self._wait_seconds}s",
            "on_wait_timeout": "CANCEL",
            "format": "JSON_ARRAY",
            "disposition": "INLINE",
        }
        if parameters:
            payload["parameters"] = [{"name": k, "value": v} for k, v in parameters.items()]
        try:
            response = await self._http.post(
                "/api/2.0/sql/statements",
                json=payload,
                headers={"authorization": f"Bearer {user_token}"},
            )
        except httpx.HTTPError as e:
            unreachable: str | None = type(e).__name__
        else:
            unreachable = None
        if unreachable is not None:
            # Raised outside the except block so the httpx error, which can quote a header
            # value (the user's token), is not left on __context__.
            raise DatabricksError(0, None, f"could not reach Databricks ({unreachable})")
        try:
            body = response.json()
        except ValueError:
            body = None
        body = body if isinstance(body, dict) else {}
        if response.status_code != 200:
            raise _error(
                response.status_code,
                body.get("error_code") if isinstance(body.get("error_code"), str) else None,
                str(body.get("message") or f"Databricks returned HTTP {response.status_code}"),
            )
        return _result(body)


def _result(body: dict[str, object]) -> QueryResult:
    status = body.get("status")
    status = status if isinstance(status, dict) else {}
    if status.get("state") != "SUCCEEDED":
        error = status.get("error")
        error = error if isinstance(error, dict) else {}
        code = error.get("error_code")
        raise _error(
            200,
            code if isinstance(code, str) else None,
            str(error.get("message") or f"statement ended as {status.get('state')}"),
        )
    manifest = body.get("manifest")
    manifest = manifest if isinstance(manifest, dict) else {}
    result = body.get("result")
    result = result if isinstance(result, dict) else {}
    schema = manifest.get("schema")
    columns = schema.get("columns") if isinstance(schema, dict) else None
    rows = result.get("data_array", [])
    statement_id = body.get("statement_id")
    if (
        not isinstance(columns, list)
        or not isinstance(rows, list)
        or not isinstance(statement_id, str)
    ):
        raise DatabricksError(200, "invalid_response", "Databricks returned an unusable response")
    # A partial result would look like a complete one, so it is an error.
    if manifest.get("truncated") or result.get("next_chunk_index") is not None:
        raise DatabricksError(200, "result_too_large", "result does not fit one inline chunk")
    return QueryResult(
        statement_id=statement_id,
        columns=[str(c.get("name")) for c in columns if isinstance(c, dict)],
        rows=rows,
    )
