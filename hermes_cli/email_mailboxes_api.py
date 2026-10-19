"""HTTP surface for per-person email mailboxes (Get ready item 7).

Every route acts on the signed-in caller's OWN mailboxes only (owner
included — nobody reads or edits another person's mailbox). Passwords are
write-only: no response ever carries one.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from hermes_cli import email_mailboxes as mailboxes

router = APIRouter(prefix="/api/email/mailboxes")


async def _caller(request: Request):
    from hermes_cli.credentials_api import _principal

    return await _principal(request, allow_as=False)


def _fail(exc: mailboxes.MailboxError) -> HTTPException:
    return HTTPException(exc.status, str(exc))


@router.get("")
async def list_mailboxes(request: Request):
    principal = await _caller(request)
    return {
        "mailboxes": await mailboxes.list_mine(principal),
        "presets": mailboxes.PRESETS,
    }


@router.put("/{address}")
async def put_mailbox(address: str, request: Request):
    principal = await _caller(request)
    try:
        body = await request.json()
    except ValueError:
        raise HTTPException(400, "body must be JSON") from None
    try:
        return {"mailbox": await mailboxes.save(principal, address, body)}
    except mailboxes.MailboxError as exc:
        raise _fail(exc) from exc


@router.delete("/{address}")
async def delete_mailbox(address: str, request: Request):
    principal = await _caller(request)
    try:
        return {"deleted": await mailboxes.delete(principal, address)}
    except mailboxes.MailboxError as exc:
        raise _fail(exc) from exc


@router.post("/{address}/test")
async def test_mailbox(address: str, request: Request):
    principal = await _caller(request)
    try:
        return {"mailbox": await mailboxes.run_test(principal, address)}
    except mailboxes.MailboxError as exc:
        raise _fail(exc) from exc
