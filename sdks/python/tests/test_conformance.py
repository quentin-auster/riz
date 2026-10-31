"""Runs the shared cases in tests/conformance; see its README for the format."""

import asyncio
import json
import socket
import threading
import time
from dataclasses import fields, is_dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest
from riz import Check, Riz, RizError

CASES = sorted((Path(__file__).parents[3] / "tests/conformance/cases").glob("*.json"))
BEARER = "svc-token"
# Case error fields that differ from the SDK attribute name.
ATTRIBUTES = {"requestId": "request_id"}


def _camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(part.title() for part in rest)


def _to_json(value: object) -> object:
    if isinstance(value, list):
        return [_to_json(v) for v in value]
    if is_dataclass(value) and not isinstance(value, type):
        return {_camel(f.name): _to_json(getattr(value, f.name)) for f in fields(value)}
    return value


def _assert_subset(actual: object, expected: object, at: str = "result") -> None:
    """Every key in `expected` must match; extra keys in `actual` are ignored."""
    if isinstance(expected, list):
        assert isinstance(actual, list), f"{at} is a list"
        assert len(actual) == len(expected), f"{at} length"
        for i, e in enumerate(expected):
            _assert_subset(actual[i], e, f"{at}[{i}]")
    elif isinstance(expected, dict):
        assert isinstance(actual, dict), f"{at} is an object"
        for k, v in expected.items():
            _assert_subset(actual.get(k), v, f"{at}.{k}")
    else:
        assert actual == expected, at


def _serve(case: dict[str, Any]) -> tuple[ThreadingHTTPServer, list[dict[str, Any]]]:
    received: list[dict[str, Any]] = []
    response = case["response"]

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            body = self.rfile.read(int(self.headers["content-length"])).decode()
            received.append(
                {
                    "method": self.command,
                    "path": self.path,
                    "headers": {k.lower(): v for k, v in self.headers.items()},
                    "body": body,
                }
            )
            if response.get("drop"):
                self.connection.shutdown(socket.SHUT_RDWR)
                return
            time.sleep(response.get("delayMs", 0) / 1000)
            payload = response.get("body")
            raw = (payload if isinstance(payload, str) else json.dumps(payload)).encode()
            try:
                self.send_response(response.get("status", 200))
                headers = {"content-type": "application/json", **response.get("headers", {})}
                for name, value in headers.items():
                    self.send_header(name, value)
                self.send_header("content-length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
            except (BrokenPipeError, ConnectionResetError):
                pass  # The client gave up (the timeout case); nothing to deliver.

        def log_message(self, format: str, *args: Any) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    # A short poll keeps shutdown() from adding half a second to every case.
    threading.Thread(
        target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True
    ).start()
    return server, received


async def _invoke(case: dict[str, Any], base_url: str) -> object:
    call = case["call"]
    timeout = case.get("client", {}).get("timeoutMs", 2000) / 1000
    async with Riz(base_url, BEARER, "crm", timeout=timeout) as riz:
        if call["operation"] == "check":
            return await riz.check(
                action=call["action"],
                resource=call["resource"],
                end_user_token=call["endUserToken"],
            )
        checks = [
            Check(c["action"], c["resource"])
            for c in call["checks"]
            for _ in range(c.get("count", 1))
        ]
        return await riz.batch_check(checks, end_user_token=call["endUserToken"])


@pytest.mark.parametrize("path", CASES, ids=lambda p: json.loads(p.read_text())["name"])
def test_conformance_case(path: Path) -> None:
    case = json.loads(path.read_text())
    server, received = _serve(case)
    result: object = None
    error: RizError | None = None
    try:
        base_url = f"http://127.0.0.1:{server.server_address[1]}"
        try:
            result = asyncio.run(_invoke(case, base_url))
        except RizError as e:
            error = e
    finally:
        server.shutdown()
        server.server_close()

    expected_request = case["expectRequest"]
    end_user_token = case["call"]["endUserToken"]
    assert len(received) == 1, "exactly one request reaches riz"
    request = received[0]
    assert request["method"] == expected_request["method"]
    assert request["path"] == expected_request["path"]
    assert request["headers"]["authorization"] == f"Bearer {BEARER}"
    assert request["headers"]["riz-end-user-token"] == end_user_token
    assert request["headers"]["content-type"].startswith("application/json")
    if "body" in expected_request:
        assert json.loads(request["body"]) == expected_request["body"]

    expected = case["expect"]
    if "error" in expected:
        expected_error = dict(expected["error"])
        assert error is not None, f"expected {expected_error['type']}, got {result!r}"
        assert type(error).__name__ == expected_error.pop("type")
        for key, value in expected_error.items():
            assert getattr(error, ATTRIBUTES.get(key, key)) == value, key
        for token in (BEARER, end_user_token):
            assert token not in str(error), "error leaks a token"
    else:
        assert error is None, repr(error)
        _assert_subset(_to_json(result), expected["result"])
