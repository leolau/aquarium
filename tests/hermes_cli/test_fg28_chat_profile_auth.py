"""FG-28 A2 — chat turns and chat reads are authorised in the requested profile.

The chat profile picker is a routing hint, never a grant (D3): a request naming
another profile re-resolves the caller in **that** profile's ``principals``, so
enrolment, suspension and owner visibility all come from the target profile.
The acting profile keeps its legacy resolver, sessionless owner-operator
fallback included, so a single-profile box is unchanged.

Real temp hermes root with a real ``profiles/hr`` home, the real profile
registry and scope switch, and a real SQLite ``state.db`` per profile. The
principal store is the only stand-in: it answers from whichever profile home is
*scoped at call time*, so a lookup made in the wrong profile is caught.
"""

from __future__ import annotations

from pathlib import Path

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
    import hermes_state
    from hermes_cli import web_server

    root = tmp_path / "hermes-root"
    hr = root / "profiles" / "hr"
    hr.mkdir(parents=True)
    monkeypatch.setattr(hermes_constants, "get_default_hermes_root", lambda: root)
    monkeypatch.setenv("HERMES_HOME", str(root))
    monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", root / "state.db")

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

    for home, owners in ((root, ("leo", "bob")), (hr, ("hana", "dan", "leo"))):
        db = hermes_state.SessionDB(db_path=home / "state.db")
        try:
            for user in owners:
                db.ensure_session(f"{home.name}-{user}", source="agent_home", user_id=user)
        finally:
            db.close()
    return {"root": root, "hr": hr}


@pytest.fixture
def client(box):
    from starlette.testclient import TestClient

    from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN, app

    c = TestClient(app)
    c.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return c


@pytest.fixture
def turns(monkeypatch):
    """Stub the one-brain runner; record who ran the turn and in which home."""
    import gateway.session_chat as session_chat

    seen: list[dict] = []

    def _fake_turn(*, session_db, user_message, conversation_history, session_id=None, **kw):
        from hermes_constants import get_hermes_home

        seen.append({
            "principal": kw.get("principal"),
            "home": Path(get_hermes_home()).resolve(),
            "session_id": session_id,
        })
        return {"final_response": "ok", "session_id": session_id}, {}

    monkeypatch.setattr(session_chat, "run_session_turn_sync", _fake_turn)
    return seen


def _as(subject: str) -> dict:
    return {SUBJECT_HEADER: subject}


def _chat(client, session_id: str, subject: str, **body):
    return client.post(
        f"/api/sessions/{session_id}/chat",
        json={"message": "hi", **body},
        headers=_as(subject),
    )


def _listed(client, subject: str, **params) -> set[str]:
    res = client.get("/api/sessions", params=params, headers=_as(subject))
    assert res.status_code == 200, res.text
    return {s["id"] for s in res.json()["sessions"]}


# -- turns -------------------------------------------------------------------


def test_a_default_member_not_enrolled_in_hr_cannot_chat_there(client, turns):
    res = _chat(client, "hr-hana", "bob", profile="hr")
    assert res.status_code == 403
    assert client.post(
        "/api/sessions", json={"profile": "hr"}, headers=_as("bob")
    ).status_code == 403
    assert turns == []


def test_a_suspended_hr_enrolment_cannot_chat_there(client, turns):
    assert _chat(client, "hr-hana", "sam", profile="hr").status_code == 403
    assert turns == []


def test_an_unknown_profile_is_refused(client, turns):
    assert _chat(client, "x", "leo", profile="nope").status_code == 404
    assert turns == []


def test_an_hr_enrollee_chats_under_their_hr_role_in_the_hr_home(client, turns, box):
    res = _chat(client, "hr-dan", "dan", profile="hr")
    assert res.status_code == 200, res.text
    (turn,) = turns
    # dan is a member of default but an admin of hr: the turn's memory user /
    # principal ticket is the hr enrolment, and it runs in the hr home.
    assert turn["principal"].user_id == "dan"
    assert turn["principal"].role == "admin"
    assert turn["home"] == box["hr"].resolve()


def test_visibility_follows_the_target_profiles_role(client):
    # hana owns hr → every hr conversation; dan is an hr admin → only his own
    # (only the owner sees every conversation in a profile).
    assert _listed(client, "hana", profile="hr") == {"hr-hana", "hr-dan", "hr-leo"}
    assert _listed(client, "dan", profile="hr") == {"hr-dan"}


def test_the_default_owner_who_is_an_hr_member_cannot_see_others_hr_chats(client, turns):
    assert _listed(client, "leo", profile="hr") == {"hr-leo"}
    res = client.get("/api/sessions/hr-hana/messages", params={"profile": "hr"}, headers=_as("leo"))
    assert res.status_code == 404
    assert _chat(client, "hr-hana", "leo", profile="hr").status_code == 404
    assert turns == []
    res = client.get(
        "/api/profiles/sessions", params={"profile": "all"}, headers=_as("leo")
    )
    assert res.status_code == 403


def test_profile_wide_tag_reads_require_enrolment_in_the_target(client):
    assert client.get(
        "/api/sessions/tags", params={"profile": "hr"}, headers=_as("bob")
    ).status_code == 403
    assert client.get(
        "/api/sessions/tags", params={"profile": "hr"}, headers=_as("dan")
    ).status_code == 200


# -- the acting profile is unchanged ------------------------------------------


def test_acting_profile_behaviour_is_unchanged(client, turns, box):
    # The default owner still sees every default conversation, by name or not.
    assert _listed(client, "leo") == {"hermes-root-leo", "hermes-root-bob"}
    assert _listed(client, "leo", profile="default") == {"hermes-root-leo", "hermes-root-bob"}
    assert _listed(client, "bob") == {"hermes-root-bob"}
    # A default member chats in default as their default role.
    assert _chat(client, "hermes-root-bob", "bob").status_code == 200
    # Sessionless (operator) callers keep the owner-operator fallback.
    assert client.post(
        "/api/sessions/hermes-root-leo/chat", json={"message": "hi"}
    ).status_code == 200
    assert [(t["principal"].user_id, t["principal"].role, t["home"]) for t in turns] == [
        ("bob", "member", box["root"].resolve()),
        ("leo", "owner", box["root"].resolve()),
    ]


# -- the picker's list ---------------------------------------------------------


def test_my_profiles_lists_every_enrolment_with_its_role(client):
    res = client.get("/api/auth/my-profiles", headers=_as("leo"))
    assert res.status_code == 200
    assert res.json() == {
        "profiles": [
            {"name": "default", "role": "owner", "active": True, "is_default": True},
            {"name": "hr", "role": "member", "active": True, "is_default": False},
        ]
    }
    res = client.get("/api/auth/my-profiles", headers=_as("sam"))
    assert res.json()["profiles"] == [
        {"name": "hr", "role": "member", "active": False, "is_default": False}
    ]


def test_my_profiles_needs_a_signed_in_subject(client):
    assert client.get("/api/auth/my-profiles").status_code == 401


def test_the_box_profile_list_is_admin_only(client):
    assert client.get("/api/profiles", headers=_as("bob")).status_code == 403
    assert client.get("/api/profiles", headers=_as("leo")).status_code == 200
    # The operator dashboard / desktop app (no interactive session) keep it.
    assert client.get("/api/profiles").status_code == 200


# -- the Users screen's per-person "Profiles & roles" read ---------------------


def test_person_profiles_lists_only_profiles_the_caller_administers(client):
    # leo owns default and is a member in hr: dan's hr admin row is not leo's
    # to see, so hr is not listed at all.
    res = client.get("/api/comms/people/dan/profiles", headers=_as("leo"))
    assert res.status_code == 200
    assert res.json() == {
        "user_id": "dan",
        "profiles": [
            {
                "name": "default",
                "is_default": True,
                "actor_role": "owner",
                "enrolled": True,
                "role": "member",
                "active": True,
                "is_owner": False,
            }
        ],
    }
    # dan administers hr only; leo's default ownership is not revealed.
    res = client.get("/api/comms/people/leo/profiles", headers=_as("dan"))
    assert [(p["name"], p["role"]) for p in res.json()["profiles"]] == [("hr", "member")]


def test_person_profiles_reports_not_enrolled_in_an_administered_profile(client):
    res = client.get("/api/comms/people/hana/profiles", headers=_as("leo"))
    assert res.json()["profiles"][0] | {} == {
        "name": "default",
        "is_default": True,
        "actor_role": "owner",
        "enrolled": False,
        "role": None,
        "active": None,
        "is_owner": False,
    }


def test_person_profiles_is_empty_for_a_caller_who_administers_nothing(client):
    for caller in ("bob", "sam"):
        res = client.get("/api/comms/people/leo/profiles", headers=_as(caller))
        assert res.status_code == 200
        assert res.json()["profiles"] == []


def test_person_profiles_needs_a_subject_and_refuses_a_profile_param(client):
    assert client.get("/api/comms/people/dan/profiles").status_code == 401
    res = client.get("/api/comms/people/dan/profiles?profile=hr", headers=_as("dan"))
    assert res.status_code == 400
