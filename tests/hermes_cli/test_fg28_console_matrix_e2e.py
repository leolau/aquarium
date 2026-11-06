"""FG-28 D-2 E2E — the cross-profile console matrix on real Postgres.

Three real profiles (``hr``, ``engineers``, ``testers``) made by the profile
API over one throwaway Postgres, each in its own FG-27-derived schema, resolved
by the real registry over a tmp hermes root. The only stand-ins are the login
gate's subject and GoTrue (accounts are box-wide; no claim here is about the
auth server). Every request goes through the real route table with
``?profile=``, and every refusal is checked where it matters: the target
schema's ``principals``, ``invitations`` and change log are byte-for-byte
unchanged.

Principals: ``cfo`` administers ``hr`` only; ``cto`` administers ``engineers``
and ``testers``; ``shared`` is a member of ``hr`` and ``engineers``.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import asyncpg
import pytest
import yaml

import hermes_cli.datastore as datastore
from hermes_cli.access import initialize_access
from hermes_cli.changes import initialize_changes
from hermes_cli.datastore import app_schema, get_store, initialize_supabase_app
from hermes_cli.invitations import initialize_invitations
from tests.hermes_cli._pg_fixture import (  # noqa: F401 — pytest fixtures
    StubAdmin,
    hermes_root,
    pg_config,
    postgres_dsn,
)

SUBJECT_HEADER = "X-Test-Subject"
PROFILES = ("hr", "engineers", "testers")

#: (user_id, role, active) per profile; ``default`` is the acting profile.
ROSTERS: dict[str, list[tuple[str, str, bool]]] = {
    "default": [("leo", "owner", True), ("dora", "member", True)],
    "hr": [
        ("hana", "owner", True),
        ("cfo", "admin", True),
        ("shared", "member", True),
        ("hiro", "member", True),
        ("sus", "admin", False),
    ],
    "engineers": [
        ("erin", "owner", True),
        ("cto", "admin", True),
        ("shared", "member", True),
        ("eve", "member", True),
    ],
    "testers": [("tess", "owner", True), ("cto", "admin", True), ("tom", "member", True)],
}

#: Accounts that have signed in; everyone else is a fresh, still-banned invitee.
SIGNED_IN = {"leo", "hana", "erin", "tess", "cfo", "cto", "shared", "dora", "sus"}


async def _reset(dsn: str) -> None:
    connection = await asyncpg.connect(dsn, ssl=False)
    try:
        for row in await connection.fetch(
            "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'app\\_%'"
        ):
            await connection.execute(f'DROP SCHEMA "{row["nspname"]}" CASCADE')
        await initialize_supabase_app(connection)
    finally:
        await connection.close()


async def _seed(home: Path, dsn: str, roster: list[tuple[str, str, bool]]) -> str:
    from hermes_cli.console_scope import _scoped_to

    with _scoped_to(home):
        datastore._verified_schemas.clear()
        store = get_store("supabase-app", "prod", config=pg_config(dsn))
        connection = await store.connect()
        try:
            await initialize_access(connection)
            await initialize_invitations(connection)
            await initialize_changes(connection)
            for user_id, role, active in roster:
                await connection.execute(
                    "INSERT INTO principals (user_id, display, role, active) "
                    "VALUES ($1, $2, $3, $4)",
                    user_id,
                    user_id.title(),
                    role,
                    active,
                )
        finally:
            await connection.close()
        return app_schema("prod")


def _account(admin: StubAdmin, user_id: str) -> None:
    signed_in = user_id in SIGNED_IN
    admin.accounts[user_id] = {
        "id": user_id,
        "email": f"{user_id}@box.test",
        "banned_until": None if signed_in else "2999-01-01T00:00:00Z",
        "last_sign_in_at": "2026-11-01T00:00:00Z" if signed_in else None,
    }


@pytest.fixture
def box(postgres_dsn, hermes_root, monkeypatch):  # noqa: F811
    import gateway.session_chat as session_chat
    import hermes_state
    from hermes_cli import web_server
    from hermes_cli.profile_registry import get_profile_registry
    from hermes_cli.profiles import create_profile

    asyncio.run(_reset(postgres_dsn))
    (hermes_root / "config.yaml").write_text(yaml.safe_dump(pg_config(postgres_dsn)))
    for name in PROFILES:
        create_profile(name, clone_from="default", clone_config=True, no_alias=True)
    homes = {e.name: e.hermes_home for e in get_profile_registry()}
    assert set(PROFILES) | {"default"} <= set(homes)

    schemas = {
        name: asyncio.run(_seed(homes[name], postgres_dsn, roster))
        for name, roster in ROSTERS.items()
    }
    assert len(set(schemas.values())) == len(schemas), schemas
    datastore._verified_schemas.clear()

    admin = StubAdmin()
    for roster in ROSTERS.values():
        for user_id, _role, _active in roster:
            _account(admin, user_id)
    monkeypatch.setattr("hermes_cli.members.load_admin_client", lambda: admin)
    monkeypatch.setattr(
        web_server,
        "_comms_session_subject",
        lambda request: (request.headers.get(SUBJECT_HEADER) or "").strip(),
    )
    monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", hermes_root / "state.db")
    turns: list[str] = []
    monkeypatch.setattr(
        session_chat,
        "run_session_turn_sync",
        lambda **kw: turns.append(kw.get("session_id")) or ({"final_response": "ok"}, {}),
    )

    from starlette.testclient import TestClient

    client = TestClient(web_server.app)
    client.headers[web_server._SESSION_HEADER_NAME] = web_server._SESSION_TOKEN
    return {
        "client": client,
        "dsn": postgres_dsn,
        "schemas": schemas,
        "admin": admin,
        "turns": turns,
    }


async def _fetch(dsn: str, sql: str, *args):
    connection = await asyncpg.connect(dsn, ssl=False)
    try:
        return [dict(r) for r in await connection.fetch(sql, *args)]
    finally:
        await connection.close()


def _snapshot(box, profile: str) -> dict[str, list]:
    schema = box["schemas"][profile]
    dsn = box["dsn"]
    return {
        table: asyncio.run(_fetch(dsn, f"SELECT {cols} FROM {schema}.{table} ORDER BY 1"))
        for table, cols in (
            ("principals", "user_id, display, role, active"),
            ("invitations", "id, user_id, kind, revoked_at, used_at"),
            ("changes", "id"),
        )
    }


def _audits(box, profile: str, action: str, user_id: str) -> list[dict]:
    rows = asyncio.run(
        _fetch(
            box["dsn"],
            f"SELECT op FROM {box['schemas'][profile]}.changes ORDER BY ts",
        )
    )
    found = []
    for row in rows:
        op = row["op"]
        op = json.loads(op) if isinstance(op, str) else op
        for entry in op:
            value = entry.get("value") or {}
            if value.get("action") == action and value.get("user_id") == user_id:
                found.append(value)
    return found


def _as(subject: str) -> dict[str, str]:
    return {SUBJECT_HEADER: subject}


def _member_ops(client, subject: str, profile: str, victim: str):
    """Every member-management verb, aimed at ``victim`` in ``profile``."""
    params = {"profile": profile}
    headers = _as(subject)
    yield "list", client.get("/api/comms/members", params=params, headers=headers)
    yield "create", client.post(
        "/api/comms/members",
        params=params,
        headers=headers,
        json={"email": f"new-{profile}@box.test", "profile": profile},
    )
    yield "role", client.put(
        f"/api/comms/members/{victim}/role",
        params=params,
        headers=headers,
        json={"role": "viewer"},
    )
    yield "deactivate", client.post(
        f"/api/comms/members/{victim}/deactivate", params=params, headers=headers
    )
    yield "delete", client.delete(
        f"/api/comms/members/{victim}", params=params, headers=headers
    )
    yield "invitation", client.post(
        f"/api/comms/members/{victim}/invitation", params=params, headers=headers
    )


@pytest.mark.parametrize(
    ("subject", "profile", "victim"),
    [
        ("cfo", "engineers", "eve"),
        ("cfo", "testers", "tom"),
        ("cto", "hr", "hiro"),
    ],
)
def test_an_admin_elsewhere_is_refused_every_verb_and_the_target_is_untouched(
    box, subject, profile, victim
):
    before = {name: _snapshot(box, name) for name in box["schemas"]}
    accounts = {k: dict(v) for k, v in box["admin"].accounts.items()}

    for verb, res in _member_ops(box["client"], subject, profile, victim):
        assert res.status_code == 403, (verb, res.status_code, res.text)

    assert {name: _snapshot(box, name) for name in box["schemas"]} == before
    assert box["admin"].accounts == accounts
    assert box["admin"].deleted == []


def test_an_admin_of_hr_acts_in_hr_and_the_audit_names_both_profiles(box):
    client = box["client"]
    res = client.put(
        "/api/comms/members/hiro/role",
        params={"profile": "hr"},
        headers=_as("cfo"),
        json={"role": "viewer"},
    )
    assert res.status_code == 200, res.text
    listed = client.get(
        "/api/comms/members", params={"profile": "hr"}, headers=_as("cfo")
    )
    assert listed.status_code == 200, listed.text

    roles = {
        name: {
            r["user_id"]: r["role"] for r in _snapshot(box, name)["principals"]
        }
        for name in box["schemas"]
    }
    assert roles["hr"]["hiro"] == "viewer"
    assert all("hiro" not in roles[name] for name in ("default", "engineers", "testers"))

    (audit,) = _audits(box, "hr", "user.role", "hiro")
    assert audit["acting_profile"] == "default"
    assert audit["target_profile"] == "hr"
    for name in ("default", "engineers", "testers"):
        assert _audits(box, name, "user.role", "hiro") == []


def test_a_suspended_enrolment_administers_nothing(box):
    before = _snapshot(box, "hr")
    for verb, res in _member_ops(box["client"], "sus", "hr", "hiro"):
        assert res.status_code == 403, (verb, res.status_code, res.text)
    assert _snapshot(box, "hr") == before


def test_an_hr_admin_mints_a_link_only_for_an_hr_only_never_activated_account(box):
    client = box["client"]
    before = _snapshot(box, "hr")
    shared = client.post(
        "/api/comms/members/shared/invitation",
        params={"profile": "hr"},
        headers=_as("cfo"),
    )
    assert shared.status_code == 403, shared.text
    assert _snapshot(box, "hr") == before

    hiro = client.post(
        "/api/comms/members/hiro/invitation",
        params={"profile": "hr"},
        headers=_as("cfo"),
    )
    assert hiro.status_code == 200, hiro.text
    assert hiro.json()["activation_path"].startswith("/activate/hr/")
    issued = _snapshot(box, "hr")["invitations"]
    assert [row["user_id"] for row in issued] == ["hiro"]
    for name in ("default", "engineers", "testers"):
        assert _snapshot(box, name)["invitations"] == []


def test_a_default_member_not_enrolled_in_hr_cannot_chat_there(box):
    res = box["client"].post(
        "/api/sessions/hr-anything/chat",
        json={"message": "hi", "profile": "hr"},
        headers=_as("dora"),
    )
    assert res.status_code == 403, res.text
    assert box["turns"] == []
