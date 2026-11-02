"""HTTP surface for per-person SQL Server connections.

Every route acts on the signed-in caller's OWN connections only (owner
included — nobody reads or edits another person's connection). Passwords are
write-only: no response ever carries one.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from hermes_cli import mssql_connections as mssql

router = APIRouter(prefix="/api/mssql/connections")


async def _caller(request: Request):
    from hermes_cli.credentials_api import _principal

    return await _principal(request, allow_as=False)


def _fail(exc: mssql.MssqlError) -> HTTPException:
    return HTTPException(exc.status, str(exc))


@router.get("")
async def list_connections(request: Request):
    principal = await _caller(request)
    return {
        "connections": await mssql.list_mine(principal),
        "driver_available": mssql.driver_available(),
    }


@router.put("/{name}")
async def put_connection(name: str, request: Request):
    principal = await _caller(request)
    try:
        body = await request.json()
    except ValueError:
        raise HTTPException(400, "body must be JSON") from None
    try:
        return {"connection": await mssql.save(principal, name, body)}
    except mssql.MssqlError as exc:
        raise _fail(exc) from exc


@router.delete("/{name}")
async def delete_connection(name: str, request: Request):
    principal = await _caller(request)
    try:
        return {"deleted": await mssql.delete(principal, name)}
    except mssql.MssqlError as exc:
        raise _fail(exc) from exc


@router.post("/{name}/test")
async def test_connection(name: str, request: Request):
    principal = await _caller(request)
    try:
        return {"connection": await mssql.run_test(principal, name)}
    except mssql.MssqlError as exc:
        raise _fail(exc) from exc
