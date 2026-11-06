"""FG-28 console routes — the wiring the unit tests cannot see.

:mod:`hermes_cli.console_scope` is right in isolation; what shipped wrong was
the *pairing* at the routes. A route that re-derives the caller in the target
profile but leaves the store on the acting profile checks authority in one
profile and takes effect in another — and a route that re-derives nothing falls
back to the target profile's **owner**, which is the one refusal FG-28 exists to
turn on.

Both are properties of the route table rather than of a handler, so they are
asserted here structurally: every ``/api/comms`` route that touches
profile-local rows must declare :func:`require_console_scope`, and every one
that binds an identity must go through the console seam rather than the legacy
resolver. That kills the bug class instead of the two instances of it.
"""

from __future__ import annotations

import asyncio
import inspect
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.routing import APIRoute

from hermes_cli import web_server as ws
from hermes_cli.access import Principal
from hermes_cli.profile_registry import ProfileRegistryEntry

#: Helpers that read or write this profile's rows. A handler calling one of
#: these resolves ``HERMES_HOME`` at call time, so it is only in the target
#: profile if the scope dependency is holding it open.
_PROFILE_LOCAL_HELPERS = (
    "_comms_member_service",
    "_comms_user_service",
    "_comms_app_store",
    "_comms_console_actor",
)

#: The legacy resolver: owner-fallback by design (the machine-operator surface).
#: Correct without ``?profile=``, forbidden with it — inside another profile's
#: scope its fallback resolves to *that* profile's owner.
_LEGACY_RESOLVER = "_comms_resolve_principal"

#: The user-management console surface — the routes a profile switcher drives.
#: Deliberately a prefix set rather than a list of paths, so a route added to
#: the console tomorrow is covered without anyone remembering to add it here.
#:
#: The rest of ``/api/comms`` (goals, traces, changes, notifications, memory)
#: is routed by the app-wide ``require_profile_scope`` (FG-28 B4), asserted in
#: ``test_fg28_profile_route_scope.py``.
_CONSOLE_PREFIXES = (
    "/api/comms/members",
    "/api/comms/directory",
    "/api/comms/whoami",
)


def _console_routes() -> list[tuple[APIRoute, str]]:
    """Every user-management console route paired with its handler's source."""
    out: list[tuple[APIRoute, str]] = []
    for route in ws.app.routes:
        if not isinstance(route, APIRoute):
            continue
        if not route.path.startswith(_CONSOLE_PREFIXES):
            continue
        out.append((route, inspect.getsource(route.endpoint)))
    return out


def _declares_console_scope(route: APIRoute) -> bool:
    return any(
        dep.call is ws.require_console_scope for dep in route.dependant.dependencies
    )


def test_every_profile_local_comms_route_declares_the_scope_dependency() -> None:
    offenders = [
        route.path
        for route, src in _console_routes()
        if any(helper + "(" in src for helper in _PROFILE_LOCAL_HELPERS)
        and not _declares_console_scope(route)
    ]
    assert offenders == [], (
        "these routes touch profile-local rows without holding the target "
        f"profile's scope, so ?profile= would take effect elsewhere: {offenders}"
    )


def test_no_comms_route_binds_an_identity_through_the_legacy_resolver_alone() -> None:
    offenders = [
        route.path
        for route, src in _console_routes()
        if _LEGACY_RESOLVER + "(" in src
    ]
    assert offenders == [], (
        "these routes bind an identity with the owner-fallback resolver; on a "
        f"?profile= request that resolves the target profile's owner: {offenders}"
    )


# -- the effect actually landing in the target profile ----------------------


def _entry(name: str, home: Path) -> ProfileRegistryEntry:
    return ProfileRegistryEntry(
        name=name,
        hermes_home=home,
        is_default=(name == "default"),
        served=True,
        base_url="" if name == "default" else f"/p/{name}/",
        schema="app_prod" if name == "default" else f"app_prod_{name}",
        has_env=False,
        gateway_running=False,
    )


class _Req:
    """The slice of ``Request`` the console seam reads."""

    def __init__(self, profile: str = "", *, subject: str = "hr-admin") -> None:
        self.query_params = {"profile": profile} if profile else {}
        self.state = SimpleNamespace()
        self._subject = subject


@pytest.fixture
def two_homes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """A default + hr registry, with the caller an admin of hr only."""
    default_home = tmp_path / "default"
    hr_home = tmp_path / "hr"
    for home in (default_home, hr_home):
        home.mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(default_home))
    entries = [_entry("default", default_home), _entry("hr", hr_home)]
    monkeypatch.setattr(
        "hermes_cli.profile_registry.get_profile_registry", lambda **kw: entries
    )
    monkeypatch.setattr("hermes_cli.console_scope.get_profile_registry", lambda **kw: entries)
    monkeypatch.setattr(ws, "_comms_session_subject", lambda request: request._subject)

    async def _resolve(subject, target, *, store_factory, registry=None):
        # Stands in for the real re-resolution: admin of hr, nothing elsewhere.
        if target != "hr" or subject != "hr-admin":
            from hermes_cli.console_scope import ProfileScopeError

            raise ProfileScopeError(f"{subject!r} is not enrolled in {target!r}")
        return Principal("hr-admin", "HR Admin", "admin")

    monkeypatch.setattr("hermes_cli.console_scope.resolve_console_principal", _resolve)

    seen: dict[str, Any] = {}

    def _service(actor=None):
        from hermes_constants import get_hermes_home

        seen["home"] = Path(str(get_hermes_home()))
        return SimpleNamespace(actor=actor)

    monkeypatch.setattr(ws, "_comms_user_service", _service)
    return default_home, hr_home, seen


async def _through_scope(route_path: str, request: _Req):
    """Run ``_comms_member_service`` the way the route table would.

    Enters the route's own declared dependency (if any) around the call, so a
    missing ``Depends(require_console_scope)`` shows up here as the wrong home
    rather than as a passing test.
    """
    route = next(
        r
        for r in ws.app.routes
        if isinstance(r, APIRoute) and r.path == route_path
    )
    if not _declares_console_scope(route):
        return await ws._comms_member_service(request)
    agen = ws.require_console_scope(request)
    await agen.__anext__()
    try:
        return await ws._comms_member_service(request)
    finally:
        with pytest.raises(StopAsyncIteration):
            await agen.__anext__()


@pytest.mark.parametrize(
    "path",
    [
        "/api/comms/members",
        "/api/comms/members/{user_id}/deactivate",
        "/api/comms/members/{user_id}/activate",
        "/api/comms/members/{user_id}",
        "/api/comms/members/{user_id}/channels",
    ],
)
def test_a_write_route_builds_its_service_in_the_target_profile(two_homes, path) -> None:
    default_home, hr_home, seen = two_homes
    asyncio.run(_through_scope(path, _Req("hr")))
    assert seen["home"] == hr_home, (
        f"{path} authorised the caller in 'hr' but built its service in "
        f"{seen['home'].name!r} — authority in one profile, effect in another"
    )
    assert seen["home"] != default_home


def test_a_console_routed_request_with_no_subject_is_401_not_the_owner(
    two_homes,
) -> None:
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as excinfo:
        asyncio.run(_through_scope("/api/comms/members/{user_id}", _Req("hr", subject="")))
    assert excinfo.value.status_code == 401


def test_a_caller_with_no_row_in_the_target_profile_is_403(two_homes) -> None:
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as excinfo:
        asyncio.run(
            _through_scope("/api/comms/members", _Req("hr", subject="stranger"))
        )
    assert excinfo.value.status_code == 403


def test_no_profile_param_leaves_the_legacy_path_byte_identical(two_homes) -> None:
    default_home, _hr_home, seen = two_homes

    async def _legacy(request, *, allow_as=False):
        return Principal("op", "Operator", "owner")

    ws_legacy = ws._comms_resolve_principal
    try:
        ws._comms_resolve_principal = _legacy
        actor, _service = asyncio.run(ws._comms_member_service(_Req()))
    finally:
        ws._comms_resolve_principal = ws_legacy
    assert actor.user_id == "op"
    assert seen["home"] == default_home


class _JsonReq(_Req):
    def __init__(self, profile: str, *, subject: str, body: dict[str, Any]) -> None:
        super().__init__(profile, subject=subject)
        self._body = body

    async def json(self) -> dict[str, Any]:
        return self._body


@pytest.fixture
def hr_roles(two_homes, monkeypatch: pytest.MonkeyPatch):
    """hr's own principals: an admin and a plain member; nobody else."""
    _default_home, hr_home, _seen = two_homes
    roles = {"hr-admin": "admin", "hr-member": "member"}

    async def _resolve(subject, target, *, store_factory, registry=None):
        from hermes_cli.console_scope import ProfileScopeError

        if target != "hr" or subject not in roles:
            raise ProfileScopeError(f"{subject!r} is not enrolled in {target!r}")
        return Principal(subject, subject, roles[subject])

    monkeypatch.setattr("hermes_cli.console_scope.resolve_console_principal", _resolve)
    created: list[dict[str, Any]] = []

    class _Service:
        def __init__(self, actor) -> None:
            from hermes_constants import get_hermes_home

            self.home = Path(str(get_hermes_home()))

        async def create_member(self, actor, **fields):
            created.append({"home": self.home, "by": actor.user_id, **fields})
            return SimpleNamespace(as_dict=lambda: {"member": {"user_id": "new"}})

    monkeypatch.setattr(ws, "_comms_user_service", _Service)
    return hr_home, created


async def _create_member(request: _JsonReq):
    agen = ws.require_console_scope(request)
    await agen.__anext__()
    try:
        return await ws.comms_create_member(request)
    finally:
        with pytest.raises(StopAsyncIteration):
            await agen.__anext__()


def test_creating_in_hr_needs_admin_authority_in_hr_itself(hr_roles) -> None:
    """The admin switcher's create (C1): the role that counts is hr's own."""
    from fastapi import HTTPException

    hr_home, created = hr_roles
    body = {"email": "n@x.io", "profile": "hr", "role": "member"}
    with pytest.raises(HTTPException) as excinfo:
        asyncio.run(_create_member(_JsonReq("hr", subject="hr-member", body=body)))
    assert excinfo.value.status_code == 403
    assert created == []

    out = asyncio.run(_create_member(_JsonReq("hr", subject="hr-admin", body=body)))
    assert out["ok"] is True
    assert [(c["home"], c["by"], c["profile"]) for c in created] == [
        (hr_home, "hr-admin", "hr")
    ]


# -- account-level verbs: guarded or self-service ---------------------------

#: GoTrue primitives that change a box-wide account, plus the one service verb
#: that hands an admin a token which does so when redeemed. Each affects every
#: profile the account is enrolled in.
_ACCOUNT_LEVEL_VERBS = frozenset(
    {
        "activate_with_password",
        "set_password",
        "set_banned",
        "delete_user",
        "issue_invitation",
    }
)

#: The single sanctioned seam for those verbs (FG-28 D4).
_ACCOUNT_GUARD = "guard_account_level_op"

#: Routes where the *holder* acts on their own account, proven by a password,
#: a single-use token or the first-run setup token — not by admin authority.
_SELF_SERVICE_PREFIXES = (
    "/api/account/password",
    "/api/auth/invitations/",
    "/api/setup/owner",
)

#: Deleting an account this same call just created, when its enrolment failed.
#: It cannot reach anybody else's account, so the walk stops there.
_ROLLBACK_ONLY = frozenset({"_rollback_account"})

_CALL_GRAPH_MODULES = (
    "hermes_cli.web_server",
    "hermes_cli.members",
    "hermes_cli.first_run",
    "hermes_cli.console_scope",
)


def _call_graph() -> dict[str, set[str]]:
    """``{function name: names it calls}`` across the account-verb modules.

    Keyed by bare name, so methods and functions that share a name merge —
    an over-approximation, which errs towards flagging a route.
    """
    import ast
    import importlib

    graph: dict[str, set[str]] = {}
    for module_name in _CALL_GRAPH_MODULES:
        tree = ast.parse(inspect.getsource(importlib.import_module(module_name)))
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            calls = graph.setdefault(node.name, set())
            for sub in ast.walk(node):
                if isinstance(sub, ast.Call):
                    func = sub.func
                    if isinstance(func, ast.Name):
                        calls.add(func.id)
                    elif isinstance(func, ast.Attribute):
                        calls.add(func.attr)
    return graph


def _reachable(start: str, graph: dict[str, set[str]]) -> set[str]:
    seen: set[str] = set()
    todo = [start]
    while todo:
        name = todo.pop()
        if name in seen:
            continue
        seen.add(name)
        if name in _ROLLBACK_ONLY:
            continue
        todo.extend(graph.get(name, ()))
    return seen


def test_the_activation_link_verb_itself_goes_through_the_guard() -> None:
    assert _ACCOUNT_GUARD in _reachable("issue_invitation", _call_graph())


def test_no_route_reaches_an_account_level_verb_without_the_guard() -> None:
    graph = _call_graph()
    offenders = []
    for route in ws.app.routes:
        if not isinstance(route, APIRoute):
            continue
        reached = _reachable(route.endpoint.__name__, graph)
        verbs = reached & _ACCOUNT_LEVEL_VERBS
        if not verbs or _ACCOUNT_GUARD in reached:
            continue
        if route.path.startswith(_SELF_SERVICE_PREFIXES):
            continue
        offenders.append((route.path, sorted(verbs)))
    assert offenders == [], (
        "these routes reach a box-wide account verb without "
        f"guard_account_level_op and are not self-service: {offenders}"
    )


def test_the_walk_sees_the_self_service_routes_it_exempts() -> None:
    """Guards the test above against a call graph that sees nothing."""
    graph = _call_graph()
    paths = {
        route.path: route
        for route in ws.app.routes
        if isinstance(route, APIRoute)
    }
    for path in ("/api/account/password", "/api/auth/invitations/redeem"):
        reached = _reachable(paths[path].endpoint.__name__, graph)
        assert reached & _ACCOUNT_LEVEL_VERBS, path


def test_an_account_level_refusal_is_a_403_with_its_reason() -> None:
    from hermes_cli.console_scope import AccountLevelPermissionError
    from hermes_cli.members import MemberAuthorizationError

    for exc in (
        AccountLevelPermissionError("enrolled in profiles you do not administer"),
        MemberAuthorizationError("already activated their account"),
    ):
        mapped = ws._comms_member_error(exc)
        assert mapped.status_code == 403
        assert mapped.detail == str(exc)
