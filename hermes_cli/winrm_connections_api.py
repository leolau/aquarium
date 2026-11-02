"""HTTP surface for per-person Windows servers (PowerShell over WinRM).

Every route acts on the signed-in caller's OWN servers only (owner
included — nobody reads or edits another person's server). Passwords are
write-only: no response ever carries one.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from hermes_cli import winrm_connections as winrm

router = APIRouter(prefix="/api/winrm/connections")


async def _caller(request: Request):
    from hermes_cli.credentials_api import _principal

    return await _principal(request, allow_as=False)


def _fail(exc: winrm.WinrmError) -> HTTPException:
    return HTTPException(exc.status, str(exc))


@router.get("")
async def list_connections(request: Request):
    principal = await _caller(request)
    return {
        "connections": await winrm.list_mine(principal),
        "driver_available": winrm.driver_available(),
    }


@router.put("/{name}")
async def put_connection(name: str, request: Request):
    principal = await _caller(request)
    try:
        body = await request.json()
    except ValueError:
        raise HTTPException(400, "body must be JSON") from None
    try:
        return {"connection": await winrm.save(principal, name, body)}
    except winrm.WinrmError as exc:
        raise _fail(exc) from exc


@router.delete("/{name}")
async def delete_connection(name: str, request: Request):
    principal = await _caller(request)
    try:
        return {"deleted": await winrm.delete(principal, name)}
    except winrm.WinrmError as exc:
        raise _fail(exc) from exc


@router.post("/{name}/test")
async def test_connection(name: str, request: Request):
    principal = await _caller(request)
    try:
        return {"connection": await winrm.run_test(principal, name)}
    except winrm.WinrmError as exc:
        raise _fail(exc) from exc
