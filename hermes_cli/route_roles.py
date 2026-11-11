"""Role gates for dashboard API routes (security review F2).

The dashboard-auth gate only proves *who* is signed in. The dependencies here
add *what role* they need. They generalise the Tools & Integrations gate
(``_require_tools_manager``): a route that changes something for every user of
the profile, or reaches the host (files, env, terminal, updates), declares
``dependencies=ADMIN`` (owner or admin) or ``dependencies=OWNER`` (owner only).
Skills routes use ``SKILLS_VIEW`` / ``SKILLS_MANAGE`` / ``SKILLS_LAB``, which
follow the profile's Settings → Skills permissions instead of a fixed role.

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

from hermes_cli.profile_route_scope import ProfileScope, require_profile_scope

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

    async def _require(
        request: Request,
        target: Optional[ProfileScope] = Depends(require_profile_scope),
    ) -> None:
        from hermes_cli import web_server as ws

        if not ws._comms_session_subject(request):
            return
        if isinstance(target, ProfileScope) and target.principal is not None:
            # ``?profile=`` names another profile: the role that counts is the
            # caller's role there (FG-28 B4), already re-resolved and refused
            # if absent or suspended by ``require_profile_scope``.
            principal = target.principal
        else:
            try:
                principal = await ws._comms_resolve_principal(request)
            except ws._CommsNotConfigured:
                return
        if not _role_allows(principal, role):
            raise HTTPException(status_code=403, detail=denied)

    _require.required_role = role  # type: ignore[attr-defined]
    _require.__name__ = f"require_{role}"
    return _require


SKILLS_DENIED = {
    "view": "Your role can't see skills in this profile. Ask the owner or an admin.",
    "manage": "Your role can't change skills in this profile. Ask the owner or an admin.",
    "lab": "Your role can't use the Skills Lab in this profile. Ask the owner or an admin.",
}


def _profile_config(target: Optional[ProfileScope]) -> dict:
    from hermes_cli.config import load_config

    if isinstance(target, ProfileScope):
        from hermes_cli.console_scope import _scoped_to

        with _scoped_to(target.entry.hermes_home):
            return load_config()
    return load_config()


def skills_dependency(action: str):
    """A FastAPI dependency: 403 unless the caller's role has skills *action*.

    *action* is a Settings → Skills permissions row (``view``, ``manage``,
    ``lab``), read from the addressed profile's config.yaml on every request
    (``tools.skills_access``). The owner always passes; callers with no login
    or no multi-user datastore pass, as for :func:`role_dependency`.
    """
    if action not in SKILLS_DENIED:
        raise ValueError(f"unknown skills action {action!r}")

    async def _require(
        request: Request,
        target: Optional[ProfileScope] = Depends(require_profile_scope),
    ) -> None:
        from hermes_cli import web_server as ws
        from tools import skills_access

        if not ws._comms_session_subject(request):
            return
        if isinstance(target, ProfileScope) and target.principal is not None:
            principal = target.principal
        else:
            try:
                principal = await ws._comms_resolve_principal(request)
            except ws._CommsNotConfigured:
                return
        if _role_allows(principal, "owner"):
            return
        if not skills_access.allows(
            getattr(principal, "role", None), action, _profile_config(target)
        ):
            raise HTTPException(status_code=403, detail=SKILLS_DENIED[action])

    _require.skills_permission = action  # type: ignore[attr-defined]
    _require.__name__ = f"require_skills_{action}"
    return _require


require_admin = role_dependency("admin", ADMIN_DENIED)
require_owner = role_dependency("owner", OWNER_DENIED)

ADMIN = [Depends(require_admin)]
OWNER = [Depends(require_owner)]
SKILLS_VIEW = [Depends(skills_dependency("view"))]
SKILLS_MANAGE = [Depends(skills_dependency("manage"))]
SKILLS_LAB = [Depends(skills_dependency("lab"))]


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
    """The role a route's dependencies require (``owner`` > ``admin``), or None.

    A skills-permission route reports ``skills:<action>``.
    """
    calls = list(_iter_dependency_calls(getattr(route, "dependant", None)))
    roles = {getattr(call, "required_role", None) for call in calls}
    if "owner" in roles:
        return "owner"
    if "admin" in roles:
        return "admin"
    for call in calls:
        action = getattr(call, "skills_permission", None)
        if action:
            return f"skills:{action}"
    return None
