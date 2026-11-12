"""``GET /api/triage/status`` — the signed-in person's triage setup (read-only).

Signed-in policy: every person sees only their own mailboxes, numbers and
calendars (see :mod:`hermes_cli.triage_status`). ``?profile=`` is accepted
like the Skills APIs; ``require_profile_scope`` refuses a profile the caller
isn't enrolled in, and the identity is the caller's own in either case.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Request

from hermes_cli import triage_status

router = APIRouter(prefix="/api/triage", tags=["triage"])


async def _caller(request: Request):
    """The signed-in person; no multi-user datastore = the single-user owner."""
    from hermes_cli.wa_bridge_api import _OPERATOR
    from hermes_cli.web_server import _CommsNotConfigured, _comms_resolve_principal

    try:
        return await _comms_resolve_principal(request, allow_as=False)
    except _CommsNotConfigured:
        return _OPERATOR


@router.get("/status")
async def get_triage_status(request: Request, profile: Optional[str] = None):
    principal = await _caller(request)
    result = await triage_status.triage_status(principal)
    return {"profile": profile or None, **result}
