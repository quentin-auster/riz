"""A FastAPI service that asks riz before returning a document.

The caller sends their own token as `Authorization: Bearer <token>`; riz verifies it and
decides whether that user may read the document. See README.md.
"""

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, HTTPException
from riz import Riz, RizApiError, RizError, RizValidationError


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    async with Riz(
        os.environ["RIZ_API_URL"],
        os.environ["RIZ_WORKLOAD_TOKEN"],
        os.environ["RIZ_APPLICATION"],
    ) as app.state.riz:
        yield


app = FastAPI(lifespan=lifespan)


@app.get("/documents/{doc_id}")
async def read_document(
    doc_id: str, authorization: str | None = Header(default=None)
) -> dict[str, str]:
    scheme, _, token = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(401, "no user credential")
    try:
        decision = await app.state.riz.check(
            action="read", resource=f"document:{doc_id}", end_user_token=token
        )
    except RizValidationError:
        raise HTTPException(404, "no such document") from None
    except RizApiError as e:
        if e.code == "invalid_end_user_token":
            raise HTTPException(401, "invalid user credential") from None
        raise HTTPException(503, "authorization unavailable") from None
    except RizError:
        # Includes "could not decide": an undecided check is a refusal.
        raise HTTPException(503, "authorization unavailable") from None
    if not decision.allowed:
        raise HTTPException(403, "denied by riz")
    return {"id": doc_id, "body": "the document"}
