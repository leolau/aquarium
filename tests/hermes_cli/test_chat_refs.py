"""Chat short refs (``C1024``) and ref mentions in chat turns (FG-36 PR 2).

Contracts:

* a chat is numbered once per **conversation** — compression continuations,
  delegate runs and tool children never get a number of their own — and
  existing chats are numbered box-wide in ``started_at`` order;
* every list/detail/search payload agent-home reads carries the
  conversation's ref, and a new chat gets the next number at create;
* ``GET /api/refs/C<n>`` answers only a caller who may read that chat **in
  its own profile** (FG-28); hidden, other-profile and missing are one 404;
* refs typed into a chat turn are described at the end of that same turn,
  only those the sender may see.

Real temp hermes root with a real ``profiles/hr`` home and real ``state.db``
files; the principal store is the only stand-in (as in
``test_fg28_chat_profile_auth.py``).
"""

from __future__ import annotations

import asyncio
import sqlite3
from pathlib import Path

import pytest

from hermes_cli import ref_mentions, short_refs
from hermes_cli.access import Principal

SUBJECT_HEADER = "X-Test-Subject"


class _ScopedPrincipals:
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


# (home, session id, owner, started_at) — creation order across profiles.
_CHATS = (
    ("root", "root-leo", "leo", 100),
    ("root", "root-bob", "bob", 200),
    ("hr", "hr-hana", "hana", 300),
    ("hr", "hr-dan", "dan", 400),
    ("hr", "hr-leo", "leo", 500),
)


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
    monkeypatch.setenv("HERMES_PROJECTS_DB", str(tmp_path / "projects.db"))
    monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", root / "state.db")

    _ScopedPrincipals.rows = {
        root.resolve(): {
            "leo": Principal("leo", "Leo", "owner"),
            "bob": Principal("bob", "Bob", "member"),
        },
        hr.resolve(): {
            "leo": Principal("leo", "Leo", "member"),
            "dan": Principal("dan", "Dan", "admin"),
            "hana": Principal("hana", "Hana", "owner"),
        },
    }
    monkeypatch.setattr("hermes_cli.access.PrincipalStore", _ScopedPrincipals)
    monkeypatch.setattr(web_server, "_comms_app_store", lambda: None)
    monkeypatch.setattr(
        web_server,
        "_comms_session_subject",
        lambda request: (request.headers.get(SUBJECT_HEADER) or "").strip(),
    )

    homes = {"root": root, "hr": hr}
    for home_key, sid, user, started in _CHATS:
        db = hermes_state.SessionDB(db_path=homes[home_key] / "state.db")
        try:
            db.ensure_session(sid, source="agent_home", user_id=user)
        finally:
            db.close()
        _set_started(homes[home_key], sid, started)

    db = hermes_state.SessionDB(db_path=root / "state.db")
    try:
        # root-leo compressed into root-leo-2: one conversation.
        db.end_session("root-leo", "compression")
        db.create_session("root-leo-2", source="agent_home", parent_session_id="root-leo")
        # A delegate subagent run under root-bob: not a chat.
        db.create_session(
            "root-bob-sub",
            source="agent_home",
            parent_session_id="root-bob",
            model_config={"_delegate_from": "root-bob"},
        )
    finally:
        db.close()
    _set_started(root, "root-leo-2", 600)
    _set_started(root, "root-bob-sub", 50)
    return homes


def _set_started(home: Path, sid: str, started: float) -> None:
    conn = sqlite3.connect(home / "state.db")
    try:
        conn.execute("UPDATE sessions SET started_at = ? WHERE id = ?", (started, sid))
        conn.commit()
    finally:
        conn.close()


@pytest.fixture
def client(box):
    from starlette.testclient import TestClient

    from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN, app

    c = TestClient(app)
    c.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return c


@pytest.fixture
def turns(monkeypatch):
    import gateway.session_chat as session_chat

    seen: list[dict] = []

    def _fake_turn(*, session_db, user_message, conversation_history, session_id=None, **kw):
        seen.append({"message": user_message, "history": list(conversation_history)})
        return {"final_response": "ok", "session_id": session_id}, {}

    monkeypatch.setattr(session_chat, "run_session_turn_sync", _fake_turn)
    return seen


def _as(subject: str) -> dict:
    return {SUBJECT_HEADER: subject}


def _refs_by_id(client, subject: str, **params) -> dict[str, str]:
    res = client.get("/api/sessions", params=params, headers=_as(subject))
    assert res.status_code == 200, res.text
    return {s["id"]: s.get("ref") for s in res.json()["sessions"]}


# -- numbering ---------------------------------------------------------------


def test_backfill_numbers_every_profiles_chats_in_creation_order(box):
    assert short_refs.backfill("C") == 5
    got = {
        r: (rec.internal_id, rec.profile)
        for r in ("C1", "C2", "C3", "C4", "C5")
        if (rec := short_refs.lookup(r)) is not None
    }
    assert got == {
        "C1": ("root-leo", "default"),
        "C2": ("root-bob", "default"),
        "C3": ("hr-hana", "hr"),
        "C4": ("hr-dan", "hr"),
        "C5": ("hr-leo", "hr"),
    }
    # The continuation and the delegate run are not chats of their own.
    assert short_refs.lookup("C6") is None


def test_list_rows_carry_the_conversations_ref_across_compression(client):
    rows = _refs_by_id(client, "leo")
    # root-leo is projected to its live tip; the ref stays the root's.
    assert rows == {"root-leo-2": "C1", "root-bob": "C2"}
    assert _refs_by_id(client, "hana", profile="hr") == {
        "hr-hana": "C3",
        "hr-dan": "C4",
        "hr-leo": "C5",
    }


def test_cross_profile_list_rows_carry_refs(client):
    res = client.get("/api/profiles/sessions", params={"profile": "all"})
    assert res.status_code == 200, res.text
    refs = {(s["profile"], s["id"]): s.get("ref") for s in res.json()["sessions"]}
    assert refs[("default", "root-leo-2")] == "C1"
    assert refs[("hr", "hr-leo")] == "C5"


def test_detail_of_any_segment_carries_the_conversations_ref(client):
    for sid in ("root-leo", "root-leo-2"):
        res = client.get(f"/api/sessions/{sid}", headers=_as("leo"))
        assert res.status_code == 200, res.text
        assert res.json()["ref"] == "C1"


def test_a_new_chat_gets_the_next_number_at_create(client):
    _refs_by_id(client, "leo")  # existing chats already numbered
    res = client.post("/api/sessions", json={"id": "home_new"}, headers=_as("bob"))
    assert res.status_code == 200, res.text
    assert res.json()["ref"] == "C6"
    assert _refs_by_id(client, "bob")["home_new"] == "C6"


def test_search_by_chat_ref_leads_with_that_chat(client):
    res = client.get("/api/sessions/search", params={"q": "c1"}, headers=_as("leo"))
    assert res.status_code == 200, res.text
    first = res.json()["results"][0]
    assert (first["session_id"], first["ref"]) == ("root-leo-2", "C1")
    # Another profile's chat ref is not a hit here.
    res = client.get("/api/sessions/search", params={"q": "C5"}, headers=_as("leo"))
    assert all(r["ref"] != "C5" for r in res.json()["results"])


# -- resolver ----------------------------------------------------------------


def test_owner_resolves_a_chat_to_its_live_tip(client):
    res = client.get("/api/refs/c1", headers=_as("leo"))
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["ref"] == "C1" and body["kind"] == "chat"
    assert body["id"] == "root-leo-2" and body["lineage_root"] == "root-leo"
    assert body["profile"] == "default"
    assert body["url"] == "/chat?session=root-leo-2&profile=default"


@pytest.mark.parametrize(
    "subject, ref, status",
    [
        ("bob", "C1", 404),   # a member never sees another person's chat
        ("bob", "C2", 200),   # ... but sees their own
        ("leo", "C5", 200),   # own chat in a profile leo is enrolled in
        ("leo", "C3", 404),   # leo is only a member in hr: hana's chat is hidden
        ("bob", "C5", 404),   # bob is not enrolled in hr at all
        ("hana", "C3", 200),  # hana is enrolled in hr only, and owns it
        ("hana", "C1", 404),  # ... and has no enrolment in default
        ("leo", "C99", 404),  # no such chat
    ],
)
def test_chat_refs_resolve_only_with_read_authority_in_their_profile(client, subject, ref, status):
    res = client.get(f"/api/refs/{ref}", headers=_as(subject))
    assert res.status_code == status, res.text
    if status == 404:
        assert res.json()["detail"] == "ref not found"


def test_cli_resolves_a_chat_ref(client, monkeypatch, capsys):
    import argparse

    from hermes_cli import projects_cli, ref_cli

    async def _principal(actor):
        return Principal("leo", "Leo", "owner")

    monkeypatch.setattr(projects_cli, "_resolve_principal", _principal)
    _refs_by_id(client, "leo")
    assert ref_cli.ref_command(argparse.Namespace(ref="C1", actor=None, json=False)) == 0
    out = capsys.readouterr().out
    assert "C1" in out and "chat" in out and "root-leo-2" in out and "profile: default" in out


# -- mentions ----------------------------------------------------------------


def test_mentioned_refs_are_deduplicated_capped_and_word_bounded():
    text = "C2, p1 and C2 again; P1-R2 not MP3 " + " ".join(f"T{i}" for i in range(1, 9))
    assert ref_mentions.mentioned_refs(text) == ["C2", "P1", "P1-R2", "T1", "T2"]
    assert len(ref_mentions.mentioned_refs(text)) == ref_mentions.MAX_EXPANDED


def test_expansion_skips_unresolved_refs_and_leaves_plain_text_alone():
    items = {"C2": {"ref": "C2", "kind": "chat", "title": "Q3\nbudget", "status": "open", "url": "/chat?x"}}

    async def _resolve(ref):
        if ref == "P9":
            raise RuntimeError("store down")
        return items.get(ref)

    out = asyncio.run(ref_mentions.expand_with("see C2, C7 and P9", _resolve))
    assert out == "see C2, C7 and P9\n\n[Referenced items]\n- C2 · chat · Q3 budget · open · /chat?x"
    assert asyncio.run(ref_mentions.expand_with("see C7", _resolve)) == "see C7"
    assert asyncio.run(ref_mentions.expand_with("no refs", _resolve)) == "no refs"


def test_a_chat_turn_gets_its_visible_refs_described_in_the_same_turn(client, turns):
    _refs_by_id(client, "leo")
    res = client.post(
        "/api/sessions/root-bob/chat",
        json={"message": "compare C1 with C2 and C99"},
        headers=_as("bob"),
    )
    assert res.status_code == 200, res.text
    (turn,) = turns
    head, block = turn["message"].split("\n\n", 1)
    assert head == "compare C1 with C2 and C99"
    # C1 is leo's chat (hidden from bob), C99 does not exist.
    assert block.splitlines() == [
        "[Referenced items]",
        "- C2 · chat · Untitled chat · open · /chat?session=root-bob&profile=default",
    ]
    # Past turns are passed through untouched; no message was added.
    assert turn["history"] == []


def test_a_turn_without_visible_refs_is_sent_as_typed(client, turns):
    res = client.post(
        "/api/sessions/root-bob/chat", json={"message": "what about C1?"}, headers=_as("bob")
    )
    assert res.status_code == 200, res.text
    assert turns[0]["message"] == "what about C1?"
