"""Role gates for dashboard API routes (security review F2).

The dashboard-auth gate only proves *who* is signed in. The dependencies here
add *what role* they need. They generalise the Tools & Integrations gate
(``_require_tools_manager``): a route that changes something for every user of
the profile, or reaches the host (files, env, terminal, updates), declares
``dependencies=ADMIN`` (owner or admin) or ``dependencies=OWNER`` (owner only).

Callers with no interactive login (operator token, CLI, desktop app, internal
calls) and single-user installs with no multi-user datastore keep full access,
exactly as the Tools gate already behaves.

Each dependency carries a ``required_role`` attribute so the route
authorisation test (``tests/hermes_cli/test_route_authorization.py``) can read
the role every route needs straight from the route table.
"""

from __future__ import annotations

from typing import Any, Iterable, Optional

from fastapi import Depends, HTTPException, Request

ADMIN_ROLES = ("owner", "admin")
ADMIN_DENIED = "Only the owner or an admin can change this setting."
OWNER_DENIED = "Only the owner can do this."


def _role_allows(principal: Any, role: str) -> bool:
    actual = getattr(principal, "role", None)
    if role == "owner":
        return actual == "owner" or bool(getattr(principal, "is_owner", False))
    return actual in ADMIN_ROLES or bool(getattr(principal, "is_owner", False))


def role_dependency(role: str, denied: str):
    """A FastAPI dependency: 403 ``denied`` unless the signed-in caller has ``role``."""
    if role not in ("admin", "owner"):
        raise ValueError(f"unknown role {role!r}")

    async def _require(request: Request) -> None:
        from hermes_cli import web_server as ws

        if not ws._comms_session_subject(request):
            return
        try:
            principal = await ws._comms_resolve_principal(request)
        except ws._CommsNotConfigured:
            return
        if not _role_allows(principal, role):
            raise HTTPException(status_code=403, detail=denied)

    _require.required_role = role  # type: ignore[attr-defined]
    _require.__name__ = f"require_{role}"
    return _require


require_admin = role_dependency("admin", ADMIN_DENIED)
require_owner = role_dependency("owner", OWNER_DENIED)

ADMIN = [Depends(require_admin)]
OWNER = [Depends(require_owner)]


async def subject_has_role(subject: str, role: str) -> bool:
    """Whether the login ``subject`` (e.g. a WebSocket ticket's user) has ``role``.

    For WebSocket routes, which cannot use HTTP dependencies. Same rules as
    :func:`role_dependency`: no subject, or no multi-user datastore, is allowed.
    """
    subject = (subject or "").strip()
    if not subject:
        return True
    from types import SimpleNamespace

    from hermes_cli import web_server as ws

    shim = SimpleNamespace(
        state=SimpleNamespace(session=SimpleNamespace(user_id=subject)),
        query_params={},
        headers={},
    )
    try:
        principal = await ws._comms_resolve_principal(shim)
    except ws._CommsNotConfigured:
        return True
    except HTTPException:
        return False
    return _role_allows(principal, role)


def _iter_dependency_calls(dependant: Any) -> Iterable[Any]:
    for dep in getattr(dependant, "dependencies", None) or ():
        yield getattr(dep, "call", None)
        yield from _iter_dependency_calls(dep)


def declared_role(route: Any) -> Optional[str]:
    """The role a route's dependencies require (``owner`` > ``admin``), or None."""
    roles = {
        getattr(call, "required_role", None)
        for call in _iter_dependency_calls(getattr(route, "dependant", None))
    }
    if "owner" in roles:
        return "owner"
    if "admin" in roles:
        return "admin"
    return None
