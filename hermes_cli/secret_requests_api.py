"""FG-37 secret prompt: the signed-in answer route.

``POST /api/secret-requests/{id}`` with ``{"values": {...}}`` stores the
secret as the owner's ``secret``-provider credential; ``{"decline": true}``
closes it. Only the owner may answer (404 unknown, 403 someone else's,
409 no longer pending). Values are never echoed or logged, every answer is
``Cache-Control: no-store``, and this prefix is outside every body-recording
middleware (see ``projects_idempotency.COVERED_PREFIXES``).
"""

from __future__ import annotations

import json
import logging

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from hermes_cli import secret_requests as sr

_log = logging.getLogger(__name__)

PREFIX = "/api/secret-requests"
router = APIRouter(prefix=PREFIX)

_NO_STORE = {"Cache-Control": "no-store", "Pragma": "no-cache"}


def _answer(status_code: int, body: dict) -> JSONResponse:
    return JSONResponse(body, status_code=status_code, headers=dict(_NO_STORE))


async def _principal(request: Request):
    from hermes_cli.web_server import _comms_resolve_principal

    return await _comms_resolve_principal(request, allow_as=False)


@router.post("/{request_id}")
async def answer_secret_request(request_id: str, request: Request):
    principal = await _principal(request)
    if principal is None:
        return _answer(401, {"detail": "sign in to answer this secret request"})
    try:
        body = json.loads((await request.body()) or b"{}")
    except (ValueError, UnicodeDecodeError):
        return _answer(400, {"detail": "body must be JSON"})
    if not isinstance(body, dict):
        return _answer(400, {"detail": "body must be a JSON object"})
    try:
        if body.get("decline") is True:
            req = sr.decline(request_id, principal=principal)
        elif "values" in body:
            req = sr.fulfil(request_id, principal=principal, values=body.get("values"))
        else:
            return _answer(400, {"detail": "send {\"values\": {...}} or {\"decline\": true}"})
    except sr.SecretRequestError as exc:
        return _answer(exc.status_code, {"detail": str(exc)})
    except Exception:
        # Never format the exception: a store error could quote the payload.
        _log.error("secret request %s could not be stored", request_id)
        return _answer(500, {"detail": "the secret could not be stored"})
    _log.info("secret request %s %s by %s", req.id, req.status, req.owner_user_id)
    return _answer(200, {"request_id": req.id, "status": req.status, "secret": req.name, "kind": req.kind})
