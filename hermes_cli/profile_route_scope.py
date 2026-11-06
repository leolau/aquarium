"""FG-28 B4: every API route either honours ``?profile=`` or refuses it.

Accounts are box-wide; authority is profile-local. agent-home names the profile
it is looking at on every call (``?profile=``, and a JSON ``profile`` where a
route reads one), but until B4 only the user-management console routes acted
on it — everything else resolved the caller and served rows in the *acting*
profile, under the other profile's name.

:func:`require_profile_scope` is installed once, app-wide, so a route added
tomorrow is covered without anyone remembering to wire it. For a request naming
a profile other than the acting one it:

* refuses the hint outright (400) on a route that reaches the host or the whole
  box, where no profile scope can make the effect profile-local;
* re-resolves the verified session subject in the **target** profile's own
  ``principals`` (:func:`resolve_console_principal`): not enrolled, suspended,
  or no datastore there → 403, never that profile's owner. A sessionless
  operator caller keeps owner-operator access, as it has in the acting profile;
* on a route that takes no ``profile`` parameter of its own, holds the target's
  scope (``HERMES_HOME``, secrets, and so the app store) for the whole handler
  — the same shape as :func:`~hermes_cli.web_server.require_console_scope`.
  A route that does declare ``profile`` already addresses the profile it names
  itself; it gets the authorisation, not a second scope.

:func:`~hermes_cli.route_roles.role_dependency` reads the principal resolved
here, so an ``ADMIN`` route called with ``?profile=hr`` checks the caller's
role in ``hr``. A request with no hint, or naming the acting profile, passes
through untouched.
"""

from __future__ import annotations

import inspect
from pathlib import Path
from typing import Any, NamedTuple, Optional

from fastapi import HTTPException
from starlette.requests import HTTPConnection, Request

#: Surfaces that own their profile semantics and are authorised elsewhere:
#: login/session and 2FA (B1–B3/B5), the account's own settings and per-person
#: preferences, which live at the box root (B5), first-run setup, and profile
#: CRUD for the operator dashboard, which names its target in the path.
SELF_SCOPED_PREFIXES = (
    "/api/auth",
    "/api/account",
    "/api/me",
    "/api/setup",
    "/api/profiles",
)

#: Routes whose effect is the host or the whole box (upgrades, VPN, git
#: worktrees, raw filesystem, process-wide dashboard state, box quotas, ops
#: subprocesses, logs, executor-run audio) — a profile scope cannot make them
#: profile-local, so naming another profile is refused rather than ignored.
BOX_WIDE_PREFIXES = (
    "/api/software-upgrade",
    "/api/hermes/update",
    "/api/security-basics",
    "/api/backups/offsite",
    "/api/vpn",
    "/api/internal/vpn",
    "/api/git",
    "/api/fs",
    "/api/files",
    "/api/browse",
    "/api/dashboard",
    "/api/system/stats",
    "/api/capacity",
    "/api/quotas/box",
    "/api/ops",
    "/api/logs",
    "/api/gateway/drain",
    "/api/audio",
    "/api/wa-bridges",
)


class ProfileScope(NamedTuple):
    """A request routed into another profile: the target and the caller there."""

    entry: Any
    #: The caller's principal in the target profile; ``None`` for a sessionless
    #: operator caller.
    principal: Any


def _under(path: str, prefixes: tuple[str, ...]) -> bool:
    return any(path == p or path.startswith(p + "/") for p in prefixes)


def _iter_calls(dependant: Any):
    for dep in getattr(dependant, "dependencies", None) or ():
        yield dep.call
        yield from _iter_calls(dep)


def _body_declares_profile(dependant: Any) -> bool:
    for field in getattr(dependant, "body_params", None) or ():
        if field.name == "profile":
            return True
        model_fields = getattr(getattr(field, "type_", None), "model_fields", None)
        if model_fields is None:
            model_fields = getattr(
                getattr(getattr(field, "field_info", None), "annotation", None),
                "model_fields",
                None,
            )
        if isinstance(model_fields, dict) and "profile" in model_fields:
            return True
    return any(
        _body_declares_profile(dep) for dep in getattr(dependant, "dependencies", ()) or ()
    )


def _query_declares_profile(dependant: Any) -> bool:
    if any(p.name == "profile" for p in getattr(dependant, "query_params", ()) or ()):
        return True
    return any(
        _query_declares_profile(dep) for dep in getattr(dependant, "dependencies", ()) or ()
    )


class RouteProfileHandling(NamedTuple):
    #: Authorised by its own target-profile seam (console scope, chat).
    own_seam: bool
    #: Declares a ``profile`` parameter and addresses that profile itself.
    declares_profile: bool
    body_profile: bool


_HANDLING_CACHE: dict[int, RouteProfileHandling] = {}


def route_profile_handling(route: Any) -> RouteProfileHandling:
    """How ``route`` already treats a ``profile`` hint (cached per route)."""
    cached = _HANDLING_CACHE.get(id(route))
    if cached is not None:
        return cached
    from hermes_cli import web_server as ws

    dependant = getattr(route, "dependant", None)
    calls = set(_iter_calls(dependant))
    try:
        source = inspect.getsource(route.endpoint)
    except (OSError, TypeError):
        source = ""
    own_seam = (
        ws.require_console_scope in calls
        or ws._chat_scope in calls
        or "_chat_principal(" in source
    )
    body_profile = _body_declares_profile(dependant)
    handling = RouteProfileHandling(
        own_seam=own_seam,
        declares_profile=body_profile or _query_declares_profile(dependant),
        body_profile=body_profile,
    )
    _HANDLING_CACHE[id(route)] = handling
    return handling


async def _profile_hint(conn: HTTPConnection, handling: RouteProfileHandling) -> str:
    profile = conn.query_params.get("profile")
    if (
        profile is None
        and handling.body_profile
        and isinstance(conn, Request)
        and conn.method not in ("GET", "HEAD")
    ):
        try:
            body = await conn.json()
        except Exception:
            body = None
        if isinstance(body, dict):
            profile = body.get("profile")
    return str(profile).strip() if profile else ""


def _request_path(conn: HTTPConnection) -> str:
    path = conn.scope.get("path") or ""
    root = conn.scope.get("root_path") or ""
    if root and path.startswith(root):
        path = path[len(root):] or "/"
    return path


async def require_profile_scope(conn: HTTPConnection):
    """App-wide dependency: honour a named non-acting profile, or refuse it."""
    if conn.scope.get("type") != "http":
        yield None
        return
    path = _request_path(conn)
    route = conn.scope.get("route")
    if (
        route is None
        or not path.startswith(("/api/", "/v1/"))
        or _under(path, SELF_SCOPED_PREFIXES)
    ):
        yield None
        return
    handling = route_profile_handling(route)
    if handling.own_seam:
        yield None
        return
    target = await _profile_hint(conn, handling)
    if not target:
        yield None
        return

    from hermes_cli.profile_registry import get_profile_registry
    from hermes_constants import get_hermes_home

    entry = next((e for e in get_profile_registry() if e.name == target), None)
    if entry is None or not entry.hermes_home.is_dir():
        if handling.declares_profile:
            # The route defines its own values (``all``, a 404 for a typo).
            yield None
            return
        raise HTTPException(status_code=403, detail=f"unknown target profile: {target!r}")
    if entry.hermes_home.resolve() == Path(get_hermes_home()).resolve():
        yield None
        return
    if _under(path, BOX_WIDE_PREFIXES):
        raise HTTPException(
            status_code=400,
            detail=(
                f"{path} acts on the whole box, not on one profile; it cannot be "
                f"scoped to profile {target!r}"
            ),
        )

    principal = await _target_principal(conn, entry)
    if handling.declares_profile:
        yield ProfileScope(entry, principal)
        return
    from hermes_cli.console_scope import _scoped_to

    note_acting_profile(conn)
    with _scoped_to(entry.hermes_home):
        yield ProfileScope(entry, principal)


async def _target_principal(conn: HTTPConnection, entry: Any) -> Optional[Any]:
    """The caller's principal in ``entry``; ``None`` for a sessionless operator."""
    from hermes_cli import web_server as ws
    from hermes_cli.access import PrincipalStore
    from hermes_cli.console_scope import ProfileScopeError, resolve_console_principal

    subject = ws._comms_session_subject(conn)
    if not subject:
        return None
    try:
        return await resolve_console_principal(
            subject,
            entry.name,
            store_factory=lambda home: PrincipalStore(ws._comms_app_store()),
            registry=[entry],
        )
    except ProfileScopeError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except (RuntimeError, LookupError, OSError) as exc:
        raise HTTPException(
            status_code=403,
            detail=f"profile {entry.name!r} cannot verify who you are there: {exc}",
        ) from exc


def note_acting_profile(conn: HTTPConnection) -> None:
    """Remember the profile this process acts as, before a scope switch.

    Inside the target's scope ``administered_profile()`` names the *target*;
    a cross-profile audit row needs both ends.
    """
    from hermes_cli.members import administered_profile

    conn.state.acting_profile = administered_profile()
