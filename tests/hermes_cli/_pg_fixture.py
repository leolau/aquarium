"""Shared real-Postgres fixtures for the FG-26/FG-28 profile E2E tests.

A throwaway Docker Postgres (skipped where Docker is unavailable), a tmp hermes
root the profile API sees, a box-wide GoTrue stand-in and a member console
running *as* one profile. Import the fixtures into a test module by name::

    from tests.hermes_cli._pg_fixture import hermes_root, postgres_dsn  # noqa: F401
"""

from __future__ import annotations

import asyncio
import shutil
import subprocess
import time
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import asyncpg
import pytest

import hermes_cli.datastore as datastore
from hermes_cli.access import PrincipalStore, initialize_access
from hermes_cli.datastore import get_store
from hermes_cli.invitations import initialize_invitations
from hermes_cli.members import MemberService

IMAGE = (
    "postgres@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193"
)


async def _probe(dsn: str) -> None:
    connection = await asyncpg.connect(dsn, ssl=False)
    await connection.close()


@pytest.fixture(scope="module")
def postgres_dsn() -> Iterator[str]:
    if shutil.which("docker") is None:
        pytest.skip("Docker is required for the Postgres E2E test")
    if (
        subprocess.run(
            ["docker", "info"], check=False, capture_output=True, text=True
        ).returncode
        != 0
    ):
        pytest.skip("Docker daemon is unavailable for the Postgres E2E test")

    subprocess.run(["docker", "pull", IMAGE], check=True, capture_output=True)
    container = f"hermes-pg-e2e-{uuid.uuid4().hex[:12]}"
    subprocess.run(
        [
            "docker",
            "run",
            "--detach",
            "--rm",
            "--name",
            container,
            "--env",
            "POSTGRES_PASSWORD=hermes-test",
            "--env",
            "POSTGRES_DB=hermes_test",
            "--publish",
            "127.0.0.1::5432",
            IMAGE,
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    try:
        port = (
            subprocess
            .run(
                ["docker", "port", container, "5432/tcp"],
                check=True,
                capture_output=True,
                text=True,
            )
            .stdout.strip()
            .rsplit(":", 1)[1]
        )
        dsn = f"postgresql://postgres:hermes-test@127.0.0.1:{port}/hermes_test"
        for _ in range(120):
            try:
                asyncio.run(_probe(dsn))
                break
            except (OSError, asyncpg.PostgresError):
                time.sleep(0.25)
        else:
            raise RuntimeError("Throwaway Postgres did not become ready")
        yield dsn
    finally:
        subprocess.run(
            ["docker", "rm", "--force", container], check=False, capture_output=True
        )


@pytest.fixture
def hermes_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A tmp hermes root whose ``profiles/`` directory the profile API sees."""
    import hermes_constants

    root = tmp_path / "hermes-root"
    (root / "profiles").mkdir(parents=True)
    monkeypatch.setattr(hermes_constants, "get_default_hermes_root", lambda: root)
    monkeypatch.setenv("HERMES_HOME", str(root))
    datastore._verified_schemas.clear()
    return root


class StubAdmin:
    """A GoTrue stand-in: accounts are box-wide, exactly as in production."""

    def __init__(self) -> None:
        self.accounts: dict[str, dict[str, Any]] = {}
        self.deleted: list[str] = []

    def create_user(
        self,
        *,
        email: str,
        password: str,
        display: str = "",
        email_confirm: bool = True,
        banned: bool = False,
    ) -> dict[str, Any]:
        user_id = str(uuid.uuid4())
        self.accounts[user_id] = {
            "id": user_id,
            "email": email,
            "banned_until": "2999-01-01T00:00:00Z" if banned else None,
        }
        return self.accounts[user_id]

    def find_user_by_email(self, email: str) -> dict[str, Any] | None:
        for account in self.accounts.values():
            if str(account.get("email", "")).lower() == email.strip().lower():
                return account
        return None

    def list_users(self, *, per_page: int = 1000) -> dict[str, dict[str, Any]]:
        return dict(self.accounts)

    def activate_with_password(self, *, user_id: str, password: str) -> None:
        self.accounts[user_id]["banned_until"] = None

    def set_password(self, *, user_id: str, password: str) -> None:
        return None

    def set_banned(self, *, user_id: str, banned: bool) -> None:
        self.accounts[user_id]["banned_until"] = (
            "2999-01-01T00:00:00Z" if banned else None
        )

    def delete_user(self, *, user_id: str) -> None:
        self.deleted.append(user_id)
        self.accounts.pop(user_id, None)


def pg_config(dsn: str) -> dict[str, object]:
    return {"datastore": {"supabase_app": {"dsn": dsn}}}


async def console(
    root: Path,
    profile: str,
    dsn: str,
    admin: StubAdmin,
    monkeypatch: pytest.MonkeyPatch,
) -> MemberService:
    """A service running *as* ``profile``, over that profile's own schema.

    Switching profile is exactly what production does — set ``HERMES_HOME`` to
    the profile directory — so the derived schema, the ownership claim and
    ``administered_profile()`` all move together and none of them can be faked
    independently by the test.
    """
    home = root if profile == "default" else root / "profiles" / profile
    home.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("HERMES_HOME", str(home))
    datastore._verified_schemas.clear()
    store = get_store("supabase-app", "prod", config=pg_config(dsn))
    connection = await store.connect()
    try:
        await initialize_access(connection)
        await initialize_invitations(connection)
        await connection.execute(
            """
            INSERT INTO principals (user_id, display, role)
            VALUES ('leo_owner', 'Leo', 'owner')
            ON CONFLICT (user_id) DO NOTHING
            """
        )
    finally:
        await connection.close()
    return MemberService(PrincipalStore(store), admin, config=pg_config(dsn))


