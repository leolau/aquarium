"""FG-28 B4 — every API route either honours ``?profile=`` or refuses it.

agent-home names the profile it is looking at on every call. Before B4 only the
user-management console routes acted on it; every other route resolved the
caller, and served rows, in the *acting* profile under the other profile's
name. ``require_profile_scope`` is now installed app-wide, so these tests run
the real route table: a real temp hermes root with a real ``profiles/hr`` home,
the real profile registry and the real scope switch. The principal store is the
only stand-in, and it answers from whichever profile home is *scoped at call
time*, so a lookup made in the wrong profile is caught.
"""

from __future__ import annotations

import inspect
from pathlib import Path
from types import SimpleNamespace

import pytest

from hermes_cli.access import Principal

SUBJECT_HEADER = "X-Test-Subject"


class _ScopedPrincipals:
    """``PrincipalStore`` stand-in keyed by the profile home in scope."""

    rows: dict[Path, dict[str, Principal]] = {}

    def __init__(self, _store=None) -> None:
        pass

    @staticmethod
    def _here() -> dict[str, Principal]:
        from hermes_constants import get_hermes_home

        return _ScopedPrincipals.rows.get(Path(get_hermes_home()).resolve(), {})

    async def resolve_alias(self, subject: str):
        return None

    async def get(self, user_id: str):
        return self._here().get(user_id)

    async def get_owner(self):
        return next((p for p in self._here().values() if p.role == "owner"), None)


@pytest.fixture
def box(tmp_path, monkeypatch):
    import hermes_constants
    from hermes_cli import web_server

    root = tmp_path / "hermes-root"
    hr = root / "profiles" / "hr"
    hr.mkdir(parents=True)
    monkeypatch.setattr(hermes_constants, "get_default_hermes_root", lambda: root)
    monkeypatch.setenv("HERMES_HOME", str(root))

    _ScopedPrincipals.rows = {
        root.resolve(): {
            "leo": Principal("leo", "Leo", "owner"),
            "bob": Principal("bob", "Bob", "member"),
            "dan": Principal("dan", "Dan", "member"),
        },
        hr.resolve(): {
            "leo": Principal("leo", "Leo", "member"),
            "dan": Principal("dan", "Dan", "admin"),
            "hana": Principal("hana", "Hana", "owner"),
            "sam": Principal("sam", "Sam", "member", active=False),
        },
    }
    monkeypatch.setattr("hermes_cli.access.PrincipalStore", _ScopedPrincipals)
    monkeypatch.setattr(web_server, "_comms_app_store", lambda: None)
    monkeypatch.setattr(
        web_server,
        "_comms_session_subject",
        lambda request: (request.headers.get(SUBJECT_HEADER) or "").strip(),
    )
    return {"root": root.resolve(), "hr": hr.resolve()}


@pytest.fixture
def client(box):
    from starlette.testclient import TestClient

    from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN, app

    c = TestClient(app)
    c.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return c


@pytest.fixture
def goals(monkeypatch):
    """The goal service, recording the home it was built in and who listed."""
    from hermes_cli import web_server

    seen: list[dict] = []

    async def _service():
        from hermes_constants import get_hermes_home

        home = Path(get_hermes_home()).resolve()

        async def list_goals(principal, *, status=None):
            seen.append({"home": home, "principal": principal})
            return []

        return SimpleNamespace(list_goals=list_goals)

    monkeypatch.setattr(web_server, "_comms_goal_service", _service)
    return seen


def _as(subject: str) -> dict:
    return {SUBJECT_HEADER: subject} if subject else {}


def _goals(client, subject: str, **params):
    return client.get("/api/comms/goals", params=params, headers=_as(subject))


# -- a legacy route honours ?profile= ---------------------------------------


def test_a_subject_not_enrolled_in_the_target_profile_is_403(client, goals):
    res = _goals(client, "bob", profile="hr")
    assert res.status_code == 403, res.text
    assert goals == [], "the handler ran for a caller with no row in hr"


def test_a_suspended_target_enrolment_is_403(client, goals):
    assert _goals(client, "sam", profile="hr").status_code == 403
    assert goals == []


def test_an_unknown_target_profile_is_403(client, goals):
    assert _goals(client, "leo", profile="nope").status_code == 403
    assert goals == []


def test_a_target_member_is_served_from_the_target_profile(client, goals, box):
    res = _goals(client, "leo", profile="hr")
    assert res.status_code == 200, res.text
    assert res.json()["principal"] == "leo"
    [call] = goals
    assert call["home"] == box["hr"], "served hr's name from another profile's store"
    assert call["principal"].role == "member", "the default owner kept their owner role in hr"


def test_a_sessionless_operator_acts_as_the_target_profiles_owner(client, goals, box):
    res = _goals(client, "", profile="hr")
    assert res.status_code == 200, res.text
    assert res.json()["principal"] == "hana"
    assert goals[0]["home"] == box["hr"]


def test_without_a_profile_the_acting_profile_is_unchanged(client, goals, box):
    res = _goals(client, "leo")
    assert res.status_code == 200, res.text
    [call] = goals
    assert call["home"] == box["root"]
    assert call["principal"].role == "owner"
    # Naming the acting profile is the same request.
    assert _goals(client, "bob", profile="default").status_code == 200
    assert goals[-1]["home"] == box["root"]


# -- role gates check the role in the target profile ------------------------


def test_an_admin_route_checks_the_callers_role_in_the_target_profile(client):
    path = "/api/cron/blueprints"
    # dan: member of default, admin of hr.
    assert client.get(path, headers=_as("dan")).status_code == 403
    assert client.get(path, params={"profile": "hr"}, headers=_as("dan")).status_code == 200
    # leo: owner of default, member of hr — the default role does not travel.
    assert client.get(path, headers=_as("leo")).status_code == 200
    assert client.get(path, params={"profile": "hr"}, headers=_as("leo")).status_code == 403
    # bob: not enrolled in hr at all.
    assert client.get(path, params={"profile": "hr"}, headers=_as("bob")).status_code == 403


def test_a_route_that_addresses_profile_itself_gets_the_target_role(client):
    # /api/env takes its own ``profile`` and reads that profile's .env.
    assert client.get("/api/env", params={"profile": "hr"}, headers=_as("dan")).status_code == 200
    assert client.get("/api/env", params={"profile": "hr"}, headers=_as("leo")).status_code == 403
    assert client.get("/api/env", headers=_as("leo")).status_code == 200


# -- a box-wide route refuses ------------------------------------------------


def test_a_box_wide_route_refuses_another_profile_instead_of_ignoring_it(client):
    res = client.get("/api/software-upgrade", params={"profile": "hr"}, headers=_as("leo"))
    assert res.status_code == 400, res.text
    assert "hr" in res.json()["detail"]
    assert client.get("/api/software-upgrade", headers=_as("leo")).status_code != 400


# -- the route table ---------------------------------------------------------


def _route_contexts():
    from hermes_cli.web_server import app

    try:
        from fastapi.routing import iter_route_contexts
    except ImportError:
        return [r for r in app.routes if hasattr(r, "path") and hasattr(r, "endpoint")]
    return list(iter_route_contexts(app.routes))


def _calls(dependant):
    for dep in getattr(dependant, "dependencies", None) or ():
        yield dep.call
        yield from _calls(dep)


def _accepts_profile(route) -> bool:
    from hermes_cli.profile_route_scope import route_profile_handling

    if route_profile_handling(route).declares_profile:
        return True
    try:
        src = inspect.getsource(route.endpoint)
    except (OSError, TypeError):
        return False
    return "profile" in src


#: Routes ``require_profile_scope`` deliberately passes through, by the seam
#: that authorises them instead. Anything else that accepts ``profile`` must be
#: honoured or refused by the shared dependency.
_PASS_THROUGH_REASONS = {
    "chat (A2: _chat_principal / _chat_scope)": lambda route, h, path: h.own_seam
    and not path.startswith(("/api/comms/",)),
    "user-management console (require_console_scope)": lambda route, h, path: h.own_seam
    and path.startswith(("/api/comms/members", "/api/comms/directory", "/api/comms/whoami")),
    "GET /api/auth/my-profiles": lambda route, h, path: path == "/api/auth/my-profiles",
    "login, session and 2FA (B1–B3, B5)": lambda route, h, path: path.startswith("/api/auth/"),
    "account-level settings (B5)": lambda route, h, path: path.startswith("/api/account/"),
    "first-run setup": lambda route, h, path: path.startswith("/api/setup/"),
    "profile CRUD for the dashboard operator": lambda route, h, path: path == "/api/profiles"
    or path.startswith("/api/profiles/"),
}


def test_every_api_route_runs_the_profile_scope_dependency():
    from hermes_cli.profile_route_scope import require_profile_scope

    missing = [
        route.path
        for route in _route_contexts()
        if route.path.startswith(("/api/", "/v1/"))
        and getattr(route, "dependant", None) is not None
        and require_profile_scope not in set(_calls(route.dependant))
    ]
    assert missing == [], (
        "these routes never see require_profile_scope, so ?profile= on them is "
        f"silently answered from the acting profile: {missing}"
    )


def test_every_route_the_dependency_passes_through_is_on_the_allowlist():
    from hermes_cli.profile_route_scope import (
        SELF_SCOPED_PREFIXES,
        _under,
        route_profile_handling,
    )

    unexplained = []
    seen_reasons: set[str] = set()
    for route in _route_contexts():
        path = route.path
        if not path.startswith(("/api/", "/v1/")) or not hasattr(route, "dependant"):
            continue
        handling = route_profile_handling(route)
        if not (handling.own_seam or _under(path, SELF_SCOPED_PREFIXES)):
            continue
        reasons = [n for n, ok in _PASS_THROUGH_REASONS.items() if ok(route, handling, path)]
        seen_reasons.update(reasons)
        if not reasons and _accepts_profile(route):
            unexplained.append(path)
    assert unexplained == [], (
        "these routes accept ?profile= but the shared dependency does not scope "
        f"them, and no allowlisted seam authorises them: {unexplained}"
    )
    assert seen_reasons == set(_PASS_THROUGH_REASONS), (
        "stale allowlist entries match no route: "
        f"{set(_PASS_THROUGH_REASONS) - seen_reasons}"
    )


def test_a_refused_box_wide_route_never_takes_a_profile_of_its_own():
    """Refusing ``?profile=`` must not break a route that defines it."""
    from hermes_cli.profile_route_scope import (
        BOX_WIDE_PREFIXES,
        _under,
        route_profile_handling,
    )

    clashing = [
        route.path
        for route in _route_contexts()
        if hasattr(route, "dependant")
        and _under(route.path, BOX_WIDE_PREFIXES)
        and route_profile_handling(route).declares_profile
    ]
    assert clashing == []
