"""Postgres E2E for the account → person map behind Settings › Accounts (FG-38 P2b).

Only the owner reads or writes the map, under FORCE row-level security as the
real NOBYPASSRLS app role too; a choice must name an active person; and the
pollers' synchronous lookup sees the choice through the real datastore.
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import shutil
import subprocess
import time
import uuid
from collections.abc import Iterator

import asyncpg
import pytest

from hermes_cli import account_owners
from hermes_cli.access import Principal, PrincipalStore, bind_principal, ensure_app_role
from hermes_cli.account_owners import AccountOwnerStore, NotOwner
from hermes_cli.changes import initialize_changes
from hermes_cli.datastore import get_store, initialize_supabase_app


async def _probe_postgres(dsn: str) -> None:
    connection = await asyncpg.connect(dsn, ssl=False)
    await connection.close()


@pytest.fixture(scope="module")
def postgres_dsn() -> Iterator[str]:
    if shutil.which("docker") is None:
        pytest.skip("Docker is required for the Postgres E2E test")
    daemon = subprocess.run(
        ["docker", "info"], check=False, capture_output=True, text=True
    )
    if daemon.returncode != 0:
        pytest.skip("Docker daemon is unavailable for the Postgres E2E test")

    image = (
        "postgres@sha256:"
        "742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193"
    )
    subprocess.run(["docker", "pull", image], check=True, capture_output=True)
    container = f"hermes-inbound-{uuid.uuid4().hex[:12]}"
    subprocess.run(
        [
            "docker", "run", "--detach", "--rm", "--name", container,
            "--env", "POSTGRES_PASSWORD=hermes-test",
            "--env", "POSTGRES_DB=hermes_test",
            "--publish", "127.0.0.1::5432",
            image,
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    try:
        port_result = subprocess.run(
            ["docker", "port", container, "5432/tcp"],
            check=True,
            capture_output=True,
            text=True,
        )
        port = port_result.stdout.strip().rsplit(":", 1)[1]
        dsn = f"postgresql://postgres:hermes-test@127.0.0.1:{port}/hermes_test"
        for _ in range(60):
            try:
                asyncio.run(_probe_postgres(dsn))
                break
            except (OSError, asyncpg.PostgresError):
                pass
            time.sleep(0.25)
        else:
            raise RuntimeError("Throwaway Postgres did not become ready")
        yield dsn
    finally:
        subprocess.run(
            ["docker", "rm", "--force", container],
            check=False,
            capture_output=True,
        )


def _config(dsn: str) -> dict:
    return {"datastore": {"supabase_app": {"dsn": dsn}}}



def _principal(user_id: str, role: str = "member") -> Principal:
    return Principal(user_id=user_id, display=user_id, role=role)  # type: ignore[arg-type]


LEO = _principal("leo", "owner")
KIT = _principal("kit", "admin")
SAM = _principal("sam", "member")


async def _store(dsn: str) -> AccountOwnerStore:
    conn = await asyncpg.connect(dsn, ssl=False)
    try:
        await conn.execute("DROP SCHEMA IF EXISTS app_prod CASCADE")
        await initialize_supabase_app(conn)
        await conn.execute("SET search_path TO app_prod")
        await initialize_changes(conn)
    finally:
        await conn.close()
    store = AccountOwnerStore(get_store("supabase-app", "prod", config=_config(dsn)))
    await store.initialize()
    people = PrincipalStore(get_store("supabase-app", "prod", config=_config(dsn)))
    await people.enroll("leo", display="Leo", role="owner")
    await people.enroll("kit", display="Kit", role="admin")
    await people.enroll("sam", display="Sam")
    await people.enroll("gone", display="Gone")
    conn = await store._store.connect()
    try:
        await conn.execute("UPDATE principals SET active = FALSE WHERE user_id = 'gone'")
    finally:
        await conn.close()
    return store


def test_owner_names_a_person_for_an_account(postgres_dsn: str) -> None:
    async def scenario() -> None:
        store = await _store(postgres_dsn)
        assert await store.set(LEO, "email", " Info@Example.com ", "sam") is None
        assert await store.get(LEO, "email", "info@example.com") == "sam"
        prev = await store.set(LEO, "email", "info@example.com", "kit")
        assert prev is not None and prev.owner_user_id == "sam"
        [row] = await store.list(LEO)
        assert (row.surface, row.account_key, row.owner_user_id, row.set_by) == (
            "email", "info@example.com", "kit", "leo",
        )
        await store.set(LEO, "email", "info@example.com", None)
        assert await store.list(LEO) == []

    asyncio.run(scenario())


def test_only_an_active_person_can_be_named(postgres_dsn: str) -> None:
    async def scenario() -> None:
        store = await _store(postgres_dsn)
        for who in ("gone", "nobody"):
            with pytest.raises(ValueError):
                await store.set(LEO, "calendar", "a@example.com", who)
        assert await store.list(LEO) == []

    asyncio.run(scenario())


@pytest.mark.parametrize("who", [KIT, SAM])
def test_nobody_but_the_owner_reads_or_writes_the_map(postgres_dsn: str, who: Principal) -> None:
    async def scenario() -> None:
        store = await _store(postgres_dsn)
        await store.set(LEO, "whatsapp", "phone1", "sam")
        with pytest.raises(NotOwner):
            await store.list(who)
        with pytest.raises(NotOwner):
            await store.get(who, "whatsapp", "phone1")
        with pytest.raises(NotOwner):
            await store.set(who, "whatsapp", "phone1", who.user_id)
        assert await store.get(LEO, "whatsapp", "phone1") == "sam"

    asyncio.run(scenario())


def test_row_level_security_hides_the_map_from_other_people(postgres_dsn: str) -> None:
    """Past the service check, as the NOBYPASSRLS app role: only an owner-bound
    session reads the map. Unbound system services (the pollers' own lookup
    binds the owner) keep the app role's usual unbound read."""

    async def scenario() -> None:
        store = await _store(postgres_dsn)
        await store.set(LEO, "email", "info@example.com", "sam")
        conn = await store._store.connect()
        try:
            await ensure_app_role(conn, "app_prod")
            await conn.execute("SET ROLE hermes_app")
            table = account_owners.ACCOUNT_OWNERS_TABLE
            for who in (KIT, SAM):
                async with conn.transaction():
                    await bind_principal(conn, who)
                    assert await conn.fetchval(f"SELECT count(*) FROM {table}") == 0
            async with conn.transaction():
                await bind_principal(conn, LEO)
                assert await conn.fetchval(f"SELECT owner_user_id FROM {table}") == "sam"
        finally:
            await conn.close()

    asyncio.run(scenario())


def test_pollers_see_the_choice_through_the_real_datastore(
    postgres_dsn: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = asyncio.run(_store(postgres_dsn))
    monkeypatch.setattr("hermes_cli.config.load_config", lambda: _config(postgres_dsn))
    account_owners._invalidate()
    assert account_owners.settings_owner("email", "info@example.com") is None
    asyncio.run(store.set(LEO, "email", "info@example.com", "sam"))
    assert account_owners.settings_owner("email", "INFO@example.com") == "sam"
    assert account_owners.settings_owner("whatsapp", "phone1") is None
    assert account_owners.settings_owner("sms", "x") is None


def test_every_choice_is_in_the_change_log(postgres_dsn: str) -> None:
    async def scenario() -> None:
        store = await _store(postgres_dsn)
        await store.set(LEO, "email", "info@example.com", "sam")
        await store.set(LEO, "email", "info@example.com", None)
        conn = await store._store.connect()
        try:
            rows = await conn.fetch("SELECT actor_user_id, payload FROM changes")
        finally:
            await conn.close()
        got = set()
        for r in rows:
            payload = json.loads(r["payload"])
            got.add((r["actor_user_id"], payload["before"], payload["after"]))
        assert got == {("leo", None, "sam"), ("leo", "sam", None)}

    asyncio.run(scenario())


def test_failed_choice_leaves_no_change_row(postgres_dsn: str) -> None:
    async def scenario() -> None:
        store = await _store(postgres_dsn)
        with pytest.raises(ValueError):
            await store.set(LEO, "email", "info@example.com", "gone")
        conn = await store._store.connect()
        try:
            assert await conn.fetchval("SELECT count(*) FROM changes") == 0
        finally:
            await conn.close()

    asyncio.run(scenario())


def test_accounts_list_says_whose_each_account_is_and_why(
    postgres_dsn: str, tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    email_config = tmp_path / "email.json"
    email_config.write_text(json.dumps({"accounts": [
        {"id": "info", "address": "Info@Example.com"},
        {"id": "sales", "address": "sales@example.com", "owner_user_id": "kit"},
        {"id": "ops", "address": "ops@example.com", "auth": "password"},
        {"id": "old", "address": "old@example.com", "enabled": False},
    ]}))
    calendar_db = tmp_path / "calendar.db"
    db = sqlite3.connect(calendar_db)
    db.execute("CREATE TABLE calendar_accounts (id TEXT, email TEXT, enabled INTEGER)")
    db.execute("INSERT INTO calendar_accounts VALUES ('c1', 'heidi@example.com', 1)")
    db.commit()
    db.close()
    wa_config = tmp_path / "wa.json"
    wa_config.write_text(json.dumps({"phones": [
        {"id": "phone1", "label": "Phone 1", "number": "+85291234567", "bridge_port": 3000},
        {"id": "phone2", "label": "Phone 2", "bridge_port": 3001},
    ]}))
    home = tmp_path / "home"
    (home / "whatsapp").mkdir(parents=True)
    (home / "whatsapp" / "bridge-owners.json").write_text(
        json.dumps({"phone2": {"user_id": "sam", "port": 3001}})
    )
    monkeypatch.setenv("HERMES_HOME", str(home))

    async def google(service: str) -> dict:
        return {"email": {"info@example.com": "kit"}, "calendar": {"heidi@example.com": "sam"}}[service]

    async def mailboxes() -> dict:
        return {"ops@example.com": "sam"}

    monkeypatch.setattr(account_owners, "_google_people", google)
    monkeypatch.setattr(account_owners, "_mailbox_people", mailboxes)

    async def scenario() -> dict:
        store = await _store(postgres_dsn)
        await store.set(LEO, "email", "info@example.com", "sam")
        await store.set(LEO, "whatsapp", "phone9", "kit")
        paths = account_owners.AccountPaths(str(email_config), str(calendar_db), str(wa_config))
        return await account_owners.discover_accounts(LEO, store, "leo", paths=paths)

    found = asyncio.run(scenario())
    got = {(a["surface"], a["account"]): (a["owner_user_id"], a["source"]) for a in found["accounts"]}
    assert got == {
        ("email", "info@example.com"): ("sam", "settings"),
        ("email", "sales@example.com"): ("kit", "config"),
        ("email", "ops@example.com"): ("sam", "connected"),
        ("email", "old@example.com"): ("leo", "install_owner"),
        ("calendar", "heidi@example.com"): ("sam", "connected"),
        ("whatsapp", "phone1"): ("leo", "install_owner"),
        ("whatsapp", "phone2"): ("sam", "connected"),
        ("whatsapp", "phone9"): ("kit", "settings"),
    }
    assert found["unreadable"] == []
    phone1 = next(a for a in found["accounts"] if a["account"] == "phone1")
    assert "91234567" not in phone1["label"]
    with pytest.raises(NotOwner):
        asyncio.run(account_owners.discover_accounts(KIT, AccountOwnerStore(
            get_store("supabase-app", "prod", config=_config(postgres_dsn))), "leo"))
