"""FG-28 D-2 E2E — two profiles, one process: secrets and schemas stay apart.

One dashboard process serves ``hr`` and ``engineers`` (real profiles made by the
profile API, real registry, one throwaway Postgres). Each profile's
``config.yaml`` names its datastore as ``${DATABASE_URL}`` and each profile's
own ``<home>/.env`` supplies a distinct value, tagged by ``application_name``;
the process ``os.environ`` carries a decoy. A recorder on the outbound database
transport (``asyncpg.connect``) sees which credential every connection was
opened with and which schema it was pinned to.

Interleaved concurrent requests for ``?profile=hr`` and ``?profile=engineers``
through ``httpx.ASGITransport`` must each connect with their own profile's
credential, write only their own schema, and never touch the decoy — the
context-local scope is the only thing keeping them apart in one event loop.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import asyncpg
import httpx
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
OWNERS = {"hr": "hana", "engineers": "erin"}
DECOY = "decoy-from-process-environ"
ROUNDS = 4


def _tagged(dsn: str, tag: str) -> str:
    return f"{dsn}?application_name={tag}"


def _tag_of(dsn: str) -> str:
    return parse_qs(urlsplit(dsn).query).get("application_name", [""])[0]


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


async def _seed(home: Path, dsn: str, owner: str) -> str:
    from hermes_cli.console_scope import _scoped_to

    with _scoped_to(home):
        datastore._verified_schemas.clear()
        store = get_store("supabase-app", "prod", config=pg_config(dsn))
        connection = await store.connect()
        try:
            await initialize_access(connection)
            await initialize_invitations(connection)
            await initialize_changes(connection)
            await connection.execute(
                "INSERT INTO principals (user_id, display, role) VALUES ($1, $1, 'owner')",
                owner,
            )
        finally:
            await connection.close()
        return app_schema("prod")


async def _members(dsn: str, schema: str) -> set[str]:
    connection = await asyncpg.connect(dsn, ssl=False)
    try:
        rows = await connection.fetch(f"SELECT user_id FROM {schema}.principals")
        return {row["user_id"] for row in rows}
    finally:
        await connection.close()


@pytest.fixture
def box(postgres_dsn, hermes_root, monkeypatch):  # noqa: F811
    from hermes_cli import web_server
    from hermes_cli.profile_registry import get_profile_registry
    from hermes_cli.profiles import create_profile

    asyncio.run(_reset(postgres_dsn))
    (hermes_root / "config.yaml").write_text(
        yaml.safe_dump({"datastore": {"supabase_app": {"dsn": "${DATABASE_URL}"}}})
    )
    (hermes_root / ".env").write_text(
        f"DATABASE_URL={_tagged(postgres_dsn, 'default-secret')}\n"
    )
    for name in OWNERS:
        create_profile(
            name,
            clone_from="default",
            clone_config=True,
            no_alias=True,
            verify_datastore=False,
        )
    homes = {e.name: e.hermes_home for e in get_profile_registry()}
    for name, home in homes.items():
        if name in OWNERS:
            (home / ".env").write_text(
                f"DATABASE_URL={_tagged(postgres_dsn, f'{name}-secret')}\n"
            )
    schemas = {
        name: asyncio.run(_seed(homes[name], postgres_dsn, owner))
        for name, owner in OWNERS.items()
    }
    assert schemas["hr"] != schemas["engineers"]
    datastore._verified_schemas.clear()
    monkeypatch.setenv("DATABASE_URL", _tagged(postgres_dsn, DECOY))

    admin = StubAdmin()
    monkeypatch.setattr("hermes_cli.members.load_admin_client", lambda: admin)
    monkeypatch.setattr(
        web_server,
        "_comms_session_subject",
        lambda request: (request.headers.get(SUBJECT_HEADER) or "").strip(),
    )

    seen: list[tuple[str, str]] = []
    real_connect = asyncpg.connect

    async def recording_connect(dsn=None, *args, **kwargs):
        search_path = (kwargs.get("server_settings") or {}).get("search_path", "")
        seen.append((_tag_of(str(dsn)), search_path))
        return await real_connect(dsn, *args, **kwargs)

    monkeypatch.setattr(asyncpg, "connect", recording_connect)
    return {"dsn": postgres_dsn, "schemas": schemas, "seen": seen, "app": web_server.app}


async def _drive(app) -> list[tuple[str, httpx.Response]]:
    from hermes_cli import web_server

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://box") as client:
        client.headers[web_server._SESSION_HEADER_NAME] = web_server._SESSION_TOKEN

        async def create(profile: str, i: int):
            res = await client.post(
                "/api/comms/members",
                params={"profile": profile},
                headers={SUBJECT_HEADER: OWNERS[profile]},
                json={"email": f"{profile}-{i}@box.test", "profile": profile},
            )
            return profile, res

        async def listing(profile: str, _i: int):
            res = await client.get(
                "/api/comms/members",
                params={"profile": profile},
                headers={SUBJECT_HEADER: OWNERS[profile]},
            )
            return profile, res

        calls = [
            verb(profile, i)
            for i in range(ROUNDS)
            for verb in (create, listing)
            for profile in ("hr", "engineers")
        ]
        return await asyncio.gather(*calls)


def test_interleaved_profiles_use_their_own_secret_and_schema(box):
    results = asyncio.run(_drive(box["app"]))
    for profile, res in results:
        assert res.status_code == 200, (profile, res.text)

    seen = box["seen"]
    schema_profile = {schema: name for name, schema in box["schemas"].items()}
    used = {(tag, schema_profile.get(path)) for tag, path in seen if path}
    assert ("hr-secret", "hr") in used and ("engineers-secret", "engineers") in used
    for tag, profile in used:
        assert tag == f"{profile}-secret", used
    assert all(tag != DECOY for tag, _path in seen), seen

    created = {
        name: {
            res.json()["member"]["user_id"]
            for p, res in results
            if p == name and res.request.method == "POST"
        }
        for name in OWNERS
    }
    assert all(len(ids) == ROUNDS for ids in created.values()), created
    for profile, schema in box["schemas"].items():
        rows = asyncio.run(_members(box["dsn"], schema))
        assert rows == {OWNERS[profile]} | created[profile]


# D-1 (FG-28 Phase D) arms secret-scope fail-closed when the dashboard serves
# more than one profile; until it lands, an unscoped read in the dashboard
# still falls back to the process environment.
@pytest.mark.xfail(strict=False, reason="FG-28 D-1: dashboard fail-closed not on develop yet")
def test_the_dashboard_fails_closed_on_an_unscoped_profile_secret(box, monkeypatch):
    import agent.secret_scope as secret_scope

    monkeypatch.setattr(secret_scope, "_MULTIPLEX_ACTIVE", secret_scope._MULTIPLEX_ACTIVE)

    async def _serve() -> None:
        app = box["app"]
        async with app.router.lifespan_context(app):
            with pytest.raises(secret_scope.UnscopedSecretError):
                secret_scope.get_secret("DATABASE_URL")

    asyncio.run(_serve())
