"""Owner/admin API for agent-home → Settings → Get ready → Security basics.

``GET /api/security-basics`` returns the last result (never re-runs);
``POST /api/security-basics/test`` runs the read-only checks now. Both only
read; nothing here changes a server setting.
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException

from hermes_cli import security_basics
from hermes_cli.route_roles import ADMIN

router = APIRouter(prefix="/api/security-basics")


@router.get("", dependencies=ADMIN)
async def get_security_basics():
    return security_basics.last_result()


@router.post("/test", dependencies=ADMIN)
async def test_security_basics():
    try:
        return await asyncio.to_thread(security_basics.run_test)
    except security_basics.Busy as exc:
        raise HTTPException(status_code=409, detail=str(exc))
