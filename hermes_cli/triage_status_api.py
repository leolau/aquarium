"""``GET /api/triage/status`` — the signed-in person's triage setup (read-only).

Signed-in policy: every person sees only their own mailboxes, numbers and
calendars (see :mod:`hermes_cli.triage_status`). The route takes no
``profile`` parameter of its own, so ``?profile=`` is handled wholly by
``require_profile_scope``: it refuses a profile the caller isn't enrolled in
and otherwise holds that profile's scope (``HERMES_HOME``, credential store,
config) for the handler, with the caller resolved in that profile.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Request

from hermes_cli import triage_status
from hermes_cli.profile_route_scope import ProfileScope, require_profile_scope

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
async def get_triage_status(
    request: Request,
    target: Optional[ProfileScope] = Depends(require_profile_scope),
):
    if isinstance(target, ProfileScope) and target.principal is not None:
        principal = target.principal
    else:
        principal = await _caller(request)
    result = await triage_status.triage_status(principal)
    if isinstance(target, ProfileScope):
        name = target.entry.name
    else:
        # No scope switch: the hint (if any) names the acting profile.
        name = (request.query_params.get("profile") or "").strip() or None
    return {"profile": name, **result}
