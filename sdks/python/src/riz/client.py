import asyncio
from collections.abc import Sequence
from dataclasses import dataclass
from types import TracebackType
from typing import Literal, Self

import httpx


class RizError(Exception):
    def __init__(self, message: str, request_id: str | None = None) -> None:
        super().__init__(message)
        self.request_id = request_id


class RizApiError(RizError):
    """riz answered with something other than a decision."""

    def __init__(
        self, status: int, code: str | None, message: str, request_id: str | None = None
    ) -> None:
        super().__init__(message, request_id)
        self.status = status
        self.code = code


class RizAuthError(RizApiError):
    """401 or 403: bad workload or end-user credentials, or a missing scope."""


class RizValidationError(RizApiError):
    """400: riz rejected the request."""


class RizIndeterminateError(RizError):
    """riz could not decide (for example its authorization backend timed out)."""

    def __init__(self, code: str | None, request_id: str) -> None:
        detail = f" ({code})" if code else ""
        super().__init__(f"riz could not decide{detail}; treat as denied", request_id)
        self.code = code


class RizTransportError(RizError):
    """riz was not reached or did not answer."""


class RizTimeoutError(RizTransportError):
    pass


@dataclass(frozen=True)
class Check:
    action: str
    resource: str


Consistency = Literal["minimize_latency", "higher_consistency"]


@dataclass(frozen=True)
class Decision:
    """`allowed` is true only for `allow`; an undecidable check raises instead."""

    allowed: bool
    status: Literal["allow", "deny"]
    request_id: str
    model_id: str | None = None


@dataclass(frozen=True)
class ItemDecision:
    allowed: bool
    status: Literal["allow", "deny", "indeterminate"]


@dataclass(frozen=True)
class BatchDecision:
    request_id: str
    # One per input check, in input order.
    results: list[ItemDecision]
    model_id: str | None = None


def _str(value: object) -> str | None:
    return value if isinstance(value, str) else None


def _http_error(status: int, parsed: object) -> RizApiError:
    body = parsed if isinstance(parsed, dict) else {}
    error_type = (
        RizValidationError
        if status == 400
        else RizAuthError
        if status in (401, 403)
        else RizApiError
    )
    return error_type(
        status,
        _str(body.get("code")),
        _str(body.get("message")) or f"riz returned HTTP {status}",
        _str(body.get("requestId")),
    )


def _invalid_response() -> RizApiError:
    return RizApiError(200, "invalid_response", "riz returned an unusable response")


def _item_decision(status: str | None) -> ItemDecision:
    # Anything that is not `allow` is not an allow; `indeterminate` is kept apart.
    if status == "allow":
        return ItemDecision(True, "allow")
    if status is None or status == "indeterminate":
        return ItemDecision(False, "indeterminate")
    return ItemDecision(False, "deny")


class Riz:
    """Async riz client. Use `async with Riz(...) as riz` so connections are closed."""

    def __init__(
        self, base_url: str, credentials: str, application: str, timeout: float = 5.0
    ) -> None:
        self._application = application
        self._timeout = timeout
        self._http = httpx.AsyncClient(
            base_url=base_url,
            headers={"authorization": f"Bearer {credentials}"},
            # The deadline is asyncio.timeout's, so it covers the whole request.
            timeout=None,
            # The end-user token must not follow a redirect to another host.
            follow_redirects=False,
        )

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        await self._http.aclose()

    async def check(
        self,
        *,
        action: str,
        resource: str,
        end_user_token: str,
        consistency: Consistency | None = None,
    ) -> Decision:
        """Whether the end user holds `action` on `resource`.

        `consistency="higher_consistency"` sees revocations already committed, at more cost;
        unset uses riz's default, `minimize_latency`, which may serve a briefly cached answer.
        Raises RizIndeterminateError when riz cannot decide; never returns allow then.
        """
        payload: dict[str, object] = {
            "application": self._application,
            "relation": action,
            "object": resource,
        }
        if consistency is not None:
            payload["consistency"] = consistency
        body = await self._post("/v1/check", end_user_token, payload)
        status = _str(body.get("status"))
        request_id = _str(body.get("requestId"))
        if status is None or request_id is None:
            raise _invalid_response()
        if status == "indeterminate":
            raise RizIndeterminateError(_str(body.get("code")), request_id)
        allowed = status == "allow"
        return Decision(
            allowed=allowed,
            status="allow" if allowed else "deny",
            request_id=request_id,
            model_id=_str(body.get("modelId")),
        )

    async def batch_check(
        self,
        checks: Sequence[Check],
        *,
        end_user_token: str,
        consistency: Consistency | None = None,
    ) -> BatchDecision:
        """At most 100 checks (riz may allow fewer). An indeterminate item does not affect the rest.

        `consistency` applies to every check in the batch, as in `check`.
        """
        payload: dict[str, object] = {
            "application": self._application,
            "checks": [
                {"correlationId": str(i), "relation": c.action, "object": c.resource}
                for i, c in enumerate(checks)
            ],
        }
        if consistency is not None:
            payload["consistency"] = consistency
        body = await self._post("/v1/batch-check", end_user_token, payload)
        request_id = _str(body.get("requestId"))
        results = body.get("results")
        if request_id is None or not isinstance(results, list):
            raise _invalid_response()
        by_id: dict[str, str | None] = {}
        for r in results:
            if isinstance(r, dict) and isinstance(r.get("correlationId"), str):
                # A repeated ID is ambiguous, so neither answer is used.
                repeated = r["correlationId"] in by_id
                by_id[r["correlationId"]] = None if repeated else _str(r.get("status"))
        return BatchDecision(
            request_id=request_id,
            model_id=_str(body.get("modelId")),
            results=[_item_decision(by_id.get(str(i))) for i in range(len(checks))],
        )

    async def _post(
        self, path: str, end_user_token: str, payload: dict[str, object]
    ) -> dict[str, object]:
        try:
            async with asyncio.timeout(self._timeout):
                response = await self._http.post(
                    path, json=payload, headers={"riz-end-user-token": end_user_token}
                )
        except TimeoutError as e:
            raise RizTimeoutError(f"riz did not answer within {self._timeout} s") from e
        except httpx.HTTPError as e:
            # No chained cause: it can quote a header value, i.e. the end-user token.
            raise RizTransportError(f"could not reach riz ({type(e).__name__})") from None
        try:
            parsed: object = response.json()
        except ValueError:
            parsed = None
        if response.status_code != 200:
            raise _http_error(response.status_code, parsed)
        if not isinstance(parsed, dict):
            raise _invalid_response()
        return parsed
