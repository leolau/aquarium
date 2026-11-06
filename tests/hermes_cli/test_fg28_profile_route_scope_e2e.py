"""FG-28 B4 E2E — a legacy route's ``?profile=`` lands in the target's real store.

Two profiles on one throwaway Postgres (FG-27's topology: one database, one
derived schema per profile), each with its own ``config.yaml``, its own real
``principals`` rows and its own goals, driven through the real route table. The
only stand-in is the login gate's subject. The claim only a real store can
settle: ``GET /api/comms/goals?profile=hr`` returns **hr's** goals, resolved
against **hr's** roster, and nothing else.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import asyncpg
import pytest
import yaml

import hermes_cli.datastore as datastore
from hermes_cli.access import Principal, initialize_access
from hermes_cli.datastore import get_store, initialize_supabase_app

# The goal service's memory layer needs pgvector, so reuse FG-11's container.
from tests.hermes_cli.test_fg11_agent_comms_e2e import postgres_dsn  # noqa: F401

SUBJECT_HEADER = "X-Test-Subject"


async def _reset(dsn: str) -> None:
    connection = await asyncpg.connect(dsn, ssl=False)
    try:
        for schema in await connection.fetch(
            "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'app\\_%'"
        ):
            await connection.execute(f'DROP SCHEMA "{schema["nspname"]}" CASCADE')
        await initialize_supabase_app(connection)
    finally:
        await connection.close()


def _config(dsn: str) -> dict:
    return {"datastore": {"supabase_app": {"dsn": dsn}}}


async def _seed(home: Path, dsn: str, people: list[Principal], goal: str) -> None:
    from hermes_cli.console_scope import _scoped_to
    from hermes_cli.goal_management import GoalManagementService

    with _scoped_to(home):
        datastore._verified_schemas.clear()
        store = get_store("supabase-app", "prod", config=_config(dsn))
        connection = await store.connect()
        try:
            await initialize_access(connection)
            for person in people:
                await connection.execute(
                    "INSERT INTO principals (user_id, display, role) VALUES ($1, $2, $3)",
                    person.user_id,
                    person.display,
                    person.role,
                )
        finally:
            await connection.close()
        service = GoalManagementService(store, audit_store=store, config=_config(dsn))
        await service.initialize()
        await service.create_goal(people[0], goal, visibility="shared", surface="web")


@pytest.fixture
def box(postgres_dsn, tmp_path, monkeypatch):  # noqa: F811
    import hermes_constants
    from hermes_cli import web_server

    asyncio.run(_reset(postgres_dsn))
    root = tmp_path / "hermes-root"
    hr = root / "profiles" / "hr"
    hr.mkdir(parents=True)
    for home in (root, hr):
        (home / "config.yaml").write_text(yaml.safe_dump(_config(postgres_dsn)))
    monkeypatch.setattr(hermes_constants, "get_default_hermes_root", lambda: root)
    monkeypatch.setenv("HERMES_HOME", str(root))
    asyncio.run(
        _seed(
            root,
            postgres_dsn,
            [Principal("leo", "Leo", "owner"), Principal("bob", "Bob", "member")],
            "default-goal",
        )
    )
    asyncio.run(
        _seed(
            hr,
            postgres_dsn,
            [Principal("hana", "Hana", "owner"), Principal("leo", "Leo", "member")],
            "hr-goal",
        )
    )
    datastore._verified_schemas.clear()
    monkeypatch.setattr(
        web_server,
        "_comms_session_subject",
        lambda request: (request.headers.get(SUBJECT_HEADER) or "").strip(),
    )
    from starlette.testclient import TestClient

    client = TestClient(web_server.app)
    client.headers[web_server._SESSION_HEADER_NAME] = web_server._SESSION_TOKEN
    return client


def _titles(res) -> set[str]:
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["configured"] is True, body
    return {g["title"] for g in body["goals"]}


def test_goals_for_another_profile_come_from_that_profiles_store(box):
    res = box.get("/api/comms/goals", params={"profile": "hr"}, headers={SUBJECT_HEADER: "leo"})
    assert _titles(res) == {"hr-goal"}


def test_the_acting_profile_is_unchanged(box):
    res = box.get("/api/comms/goals", headers={SUBJECT_HEADER: "leo"})
    assert _titles(res) == {"default-goal"}


def test_a_subject_with_no_row_in_the_target_is_refused_not_served(box):
    res = box.get("/api/comms/goals", params={"profile": "hr"}, headers={SUBJECT_HEADER: "bob"})
    assert res.status_code == 403, res.text
    assert "hr-goal" not in res.text and "default-goal" not in res.text
