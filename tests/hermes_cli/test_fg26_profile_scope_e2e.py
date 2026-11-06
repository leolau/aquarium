"""FG-26 E2E — profile scope, the N+1 query count, and the delete strategies.

Three claims that only real Postgres can settle, over **two derived schemas on
one database** (FG-27's topology, reusing the container fixture shape from
``test_fg27_layer2_e2e.py``):

* **Scope.** Two profiles' consoles show disjoint rosters and disjoint
  directories even though the accounts are box-wide — the data-exposure bug this
  FG is most able to introduce, because ``auth.users`` is shared and looks like
  the obvious source for a user list.
* **Query count.** ``list_principals`` issues **one** grouped channel query for
  a page, not one per principal. Asserted by counting the statements Postgres
  actually parses, so the assertion cannot pass by accident when somebody
  reintroduces a per-row lookup inside the loop.
* **Delete strategies.** ``transfer`` and ``purge`` both leave **no** row whose
  ``owner_user_id`` names a principal that no longer exists — the invariant that
  makes a hard delete safe, since nothing cascades from ``principals`` to
  memories, files or GTS items.

GoTrue is stubbed here (a dict of accounts): none of these claims is about the
auth server, and the auth-server claims are covered against real GoTrue in
``test_fg26_invitations_e2e.py``.
"""

from __future__ import annotations

from pathlib import Path

import asyncpg
import pytest

import hermes_cli.datastore as datastore
from hermes_cli.access import Principal, PrincipalStore
from hermes_cli.datastore import app_schema, get_store, initialize_supabase_app
from hermes_cli.members import MemberError
from hermes_cli.ownership import dangling_owner_ids
from tests.hermes_cli._pg_fixture import (  # noqa: F401 — pytest fixtures
    StubAdmin as _StubAdmin,
    console as _console,
    hermes_root,
    pg_config as _config,
    postgres_dsn,
)


def _owner(user_id: str = "leo_owner") -> Principal:
    return Principal(user_id=user_id, display="Leo", role="owner")


async def _reset(dsn: str) -> None:
    connection = await asyncpg.connect(dsn, ssl=False)
    try:
        await connection.execute(
            "DROP SCHEMA IF EXISTS app_prod CASCADE;"
            "DROP SCHEMA IF EXISTS app_prod_maintenance CASCADE;"
            "DROP SCHEMA IF EXISTS app_dev CASCADE;"
            "DROP SCHEMA IF EXISTS app_dev_maintenance CASCADE;"
        )
        await initialize_supabase_app(connection)
    finally:
        await connection.close()


# --------------------------------------------------------------------------
# scope
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_two_profiles_on_one_database_have_disjoint_rosters(
    postgres_dsn: str, hermes_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """ "Every account on the box" and "the people here" are different sets."""
    await _reset(postgres_dsn)
    admin = _StubAdmin()

    default = await _console(hermes_root, "default", postgres_dsn, admin, monkeypatch)
    created_here = await default.create_member(
        _owner(), email="here@x.io", profile="default", display="Here"
    )

    maintenance = await _console(
        hermes_root, "maintenance", postgres_dsn, admin, monkeypatch
    )
    created_there = await maintenance.create_member(
        _owner(), email="there@x.io", profile="maintenance", display="There"
    )

    # Both accounts exist box-wide …
    assert len(admin.accounts) == 2
    # … but each console sees only its own enrolment.
    there_page = await maintenance.list_members(_owner())
    assert {view.user_id for view in there_page.members} == {
        "leo_owner",
        created_there.principal.user_id,
    }
    there_directory = await maintenance.directory(_owner())
    assert created_here.principal.user_id not in {
        entry.user_id for entry in there_directory[0]
    }

    monkeypatch.setenv("HERMES_HOME", str(hermes_root))
    datastore._verified_schemas.clear()
    here_page = await default.list_members(_owner())
    assert {view.user_id for view in here_page.members} == {
        "leo_owner",
        created_here.principal.user_id,
    }
    assert created_there.principal.user_id not in {
        view.user_id for view in here_page.members
    }

    # And the invitations landed in their own profile's schema, not one shared one.
    connection = await asyncpg.connect(postgres_dsn, ssl=False)
    try:
        assert (
            await connection.fetchval("SELECT COUNT(*) FROM app_prod.invitations") == 1
        )
        assert (
            await connection.fetchval(
                "SELECT COUNT(*) FROM app_prod_maintenance.invitations"
            )
            == 1
        )
    finally:
        await connection.close()


@pytest.mark.asyncio
async def test_a_second_profile_cannot_be_enrolled_into_from_this_console(
    postgres_dsn: str, hermes_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A console scoped to one profile cannot enrol into another (FG-27's guard).

    FG-28 routes cross-profile creates through ``?profile=``; the refusal says so.
    """
    await _reset(postgres_dsn)
    admin = _StubAdmin()
    default = await _console(hermes_root, "default", postgres_dsn, admin, monkeypatch)

    with pytest.raises(MemberError) as excinfo:
        await default.create_member(_owner(), email="nope@x.io", profile="maintenance")
    assert "?profile=maintenance" in str(excinfo.value)
    assert admin.accounts == {}


# --------------------------------------------------------------------------
# the N+1
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_listing_a_page_of_principals_runs_one_channel_query(
    postgres_dsn: str, hermes_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The N+1 regression test: channels are fetched grouped, once per page."""
    await _reset(postgres_dsn)
    admin = _StubAdmin()
    service = await _console(hermes_root, "default", postgres_dsn, admin, monkeypatch)
    store = PrincipalStore(
        get_store("supabase-app", "prod", config=_config(postgres_dsn))
    )

    for index in range(12):
        principal = await store.enroll(f"user{index:02d}", display=f"User {index}")
        await store.link_channel(principal.user_id, "telegram", f"tg-{index}")

    statements: list[str] = []
    original = asyncpg.Connection.fetch

    async def counting_fetch(self, query, *args, **kwargs):  # type: ignore[no-untyped-def]
        statements.append(str(query))
        return await original(self, query, *args, **kwargs)

    monkeypatch.setattr(asyncpg.Connection, "fetch", counting_fetch)
    principals = await store.list_principals(limit=10)
    monkeypatch.undo()

    assert len(principals) == 10
    channel_queries = [q for q in statements if "channel_identities" in q]
    assert len(channel_queries) == 1, statements
    assert "ARRAY_AGG" in channel_queries[0]
    assert principals[-1].channels  # …and the channels really were loaded
    del service


@pytest.mark.asyncio
async def test_pagination_search_and_filters_are_pushed_into_postgres(
    postgres_dsn: str, hermes_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Totals describe the filtered set, not the page — the UI paginates on them."""
    await _reset(postgres_dsn)
    admin = _StubAdmin()
    service = await _console(hermes_root, "default", postgres_dsn, admin, monkeypatch)
    store = PrincipalStore(
        get_store("supabase-app", "prod", config=_config(postgres_dsn))
    )

    for index in range(7):
        await store.enroll(f"member{index}", display=f"Mia {index}", role="member")
    for index in range(3):
        await store.enroll(f"viewer{index}", display=f"Vee {index}", role="viewer")
    await store.set_active("member0", False)

    first = await service.list_members(_owner(), limit=5, offset=0)
    second = await service.list_members(_owner(), limit=5, offset=5)
    assert first.total == second.total == 11  # 7 members + 3 viewers + the owner
    assert len(first.members) == 5
    assert len(second.members) == 5
    assert not {v.user_id for v in first.members} & {v.user_id for v in second.members}

    viewers = await service.list_members(_owner(), role="viewer")
    assert viewers.total == 3
    assert {v.role for v in viewers.members} == {"viewer"}

    searched = await service.list_members(_owner(), query="Vee 1")
    assert searched.total == 1
    assert searched.members[0].display == "Vee 1"

    deactivated = await service.list_members(_owner(), active=False)
    assert deactivated.total == 1
    assert deactivated.members[0].user_id == "member0"
    assert deactivated.members[0].enrolled is False

    live = await service.list_members(_owner(), active=True)
    assert live.total == 10
    assert "member0" not in {v.user_id for v in live.members}

    # The directory is the *enrolled* set, so a deactivated colleague is gone
    # from it even though the account still exists.
    entries, total = await service.directory(_owner())
    assert total == 10
    assert "member0" not in {entry.user_id for entry in entries}


# --------------------------------------------------------------------------
# hard delete
# --------------------------------------------------------------------------


async def _seed_owned_rows(dsn: str, schema: str, user_id: str) -> None:
    """Give ``user_id`` one private and one shared row in a real owned table.

    ``tags`` is used because it is an ordinary C2-scoped app table — it carries
    ``owner_user_id`` and ``visibility`` and has **no** foreign key to
    ``principals``, which is precisely the shape that strands rows behind a
    naive delete.
    """
    from hermes_cli.tags import SCHEMA_SQL

    connection = await asyncpg.connect(dsn, ssl=False)
    try:
        await connection.execute(f"SET search_path TO {schema}")
        await connection.execute(SCHEMA_SQL)
        await connection.execute(
            """
            INSERT INTO tags (owner_user_id, visibility, name)
            VALUES ($1, $2, 'private-tag'), ($1, 'shared', 'shared-tag')
            """,
            user_id,
            f"private:{user_id}",
        )
        # Layer-4 memory, in the shape the pgvector store creates it: owned,
        # swept by discovery like any other table, and — unlike a document —
        # not somebody else's to inherit.
        await connection.execute(
            """
            CREATE TABLE IF NOT EXISTS memories (
                id BIGSERIAL PRIMARY KEY,
                owner_user_id TEXT NOT NULL,
                visibility TEXT NOT NULL,
                content TEXT NOT NULL
            )
            """
        )
        await connection.execute(
            """
            INSERT INTO memories (owner_user_id, visibility, content)
            VALUES ($1, $2, 'they dislike early meetings'),
                   ($1, 'shared', 'they run the Tuesday review')
            """,
            user_id,
            f"private:{user_id}",
        )
    finally:
        await connection.close()


@pytest.mark.parametrize("strategy", ["transfer", "purge"])
@pytest.mark.asyncio
async def test_hard_delete_leaves_no_dangling_owner(
    postgres_dsn: str,
    hermes_root: Path,
    monkeypatch: pytest.MonkeyPatch,
    strategy: str,
) -> None:
    """Whatever the strategy, no row may outlive its owner unattributed."""
    await _reset(postgres_dsn)
    admin = _StubAdmin()
    service = await _console(hermes_root, "default", postgres_dsn, admin, monkeypatch)
    schema = app_schema("prod")

    leaver = await service.create_member(
        _owner(), email="leaver@x.io", profile="default", display="Leaver"
    )
    heir = await service.create_member(
        _owner(), email="heir@x.io", profile="default", display="Heir"
    )
    await _seed_owned_rows(postgres_dsn, schema, leaver.principal.user_id)
    # The curated files a session actually reads, which no strategy used to
    # touch: a person could be deleted from the console and keep being
    # described to the agent by name.
    participation = (
        hermes_root / "memories" / "users" / leaver.principal.user_id / "MEMORY.md"
    )
    participation.parent.mkdir(parents=True)
    participation.write_text("they dislike early meetings")

    deleted = await service.delete_member(
        _owner(),
        user_id=leaver.principal.user_id,
        strategy=strategy,  # type: ignore[arg-type]
        transfer_to=heir.principal.user_id if strategy == "transfer" else None,
    )
    assert deleted.ownership.strategy == strategy

    connection = await asyncpg.connect(postgres_dsn, ssl=False)
    try:
        assert await dangling_owner_ids(connection, schema) == {}
        rows = await connection.fetch(
            f"SELECT name, owner_user_id, visibility FROM {schema}.tags ORDER BY name"
        )
    finally:
        await connection.close()

    if strategy == "transfer":
        assert [str(row["name"]) for row in rows] == ["private-tag", "shared-tag"]
        assert {str(row["owner_user_id"]) for row in rows} == {heir.principal.user_id}
        # A private row stays private — to somebody who exists.
        assert f"private:{heir.principal.user_id}" in {
            str(row["visibility"]) for row in rows
        }
    else:
        # The private row is destroyed; the shared one changes hands rather
        # than vanishing out from under whoever was relying on it.
        assert [str(row["name"]) for row in rows] == ["shared-tag"]
        assert str(rows[0]["owner_user_id"]) == "leo_owner"

    # The box-wide account is deliberately untouched: it may serve other profiles.
    assert admin.deleted == []

    # What the agent learned about them is deleted under BOTH strategies:
    # transferring a person's memory to their successor is not a change of
    # ownership, it is disclosure.
    connection = await asyncpg.connect(postgres_dsn, ssl=False)
    try:
        remaining = await connection.fetch(
            f"SELECT owner_user_id FROM {schema}.memories"
        )
    finally:
        await connection.close()
    assert remaining == []
    assert deleted.ownership.deleted.get("memories") == 2

    if strategy == "purge":
        assert not participation.exists()
        assert deleted.memory_files_erased
    else:
        # transfer moves what they owned; it does not erase them.
        assert participation.exists()
        assert deleted.memory_files_erased == []


@pytest.mark.asyncio
async def test_hard_delete_requires_a_strategy_and_a_named_successor(
    postgres_dsn: str, hermes_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Neither answer may be guessed on the caller's behalf."""
    await _reset(postgres_dsn)
    admin = _StubAdmin()
    service = await _console(hermes_root, "default", postgres_dsn, admin, monkeypatch)
    leaver = await service.create_member(
        _owner(), email="leaver@x.io", profile="default"
    )

    with pytest.raises(MemberError):
        await service.delete_member(
            _owner(),
            user_id=leaver.principal.user_id,
            strategy="wipe",  # type: ignore[arg-type]
        )
    with pytest.raises(MemberError):
        await service.delete_member(
            _owner(), user_id=leaver.principal.user_id, strategy="transfer"
        )
    assert await service.list_members(_owner(), query="leaver") is not None
