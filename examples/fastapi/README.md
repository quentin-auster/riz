# FastAPI example

`main.py` serves `GET /documents/{id}` and calls `riz.check(action="read", ...)` with the
caller's own bearer token. riz allowing returns 200; riz denying returns 403; a missing or
unknown token returns 401; riz unreachable or unable to decide returns 503, never an allow.

Do the [setup](../README.md#setup-fastapi-and-express) first, then from the repo root:

```sh
uv run --project examples/fastapi uvicorn main:app --app-dir examples/fastapi --port 8101
```

In another terminal:

```sh
curl -i localhost:8101/documents/d1 -H 'authorization: Bearer dev-alice-token'   # 200
curl -i localhost:8101/documents/d2 -H 'authorization: Bearer dev-alice-token'   # 403
curl -i localhost:8101/documents/d1                                              # 401
```

The SDK is installed from this checkout (`sdks/python`) because it is not published yet.
