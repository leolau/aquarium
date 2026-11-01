"""A malformed id on a ``/api/registry/*/{id}`` route is a 404, never a 500.

The registry tables key on ``UUID``. Handing Postgres a string that is not one
fails the ``::uuid`` cast (``asyncpg.DataError`` → an unhandled 500) instead of
matching nothing, so each store treats a malformed id exactly like an absent
one and never opens a connection for it. The unit half proves the short
circuit without a database; the E2E half runs the real SQL against a
throwaway Postgres (``initdb``; skipped when the server binaries are absent).
"""

from __future__ import annotations

import asyncio
import glob
import os
import shutil
import socket
import subprocess
import uuid
from typing import Iterator

import pytest
from fastapi import HTTPException

from hermes_cli import files_api, incomings_api, memory_explorer
from hermes_cli.access import Principal, is_uuid
from hermes_cli.file_registry import FileRegistry
from hermes_cli.inbound_registry import InboundRegistry
from hermes_cli.tags import TagRegistry

MALFORMED = ["zz-smoke-missing", "not-a-uuid", "1; DROP TABLE inbound_items", ""]
ABSENT = "00000000-0000-4000-8000-000000000000"

LEO = Principal(user_id="leo", display="Leo", role="owner")  # type: ignore[arg-type]
ADA = Principal(user_id="ada", display="Ada", role="member")  # type: ignore[arg-type]


class _NoConnectStore:
    mode = "prod"

    async def connect(self):
        raise AssertionError("a malformed id must not reach Postgres")


async def _async(value):
    return value


def test_is_uuid() -> None:
    assert is_uuid(ABSENT)
    assert is_uuid(uuid.uuid4())
    assert is_uuid(str(uuid.uuid4()).upper())
    for value in MALFORMED + [None, "tsk_1"]:
        assert not is_uuid(value)


@pytest.mark.parametrize("bad_id", MALFORMED)
def test_inbound_registry_treats_a_malformed_id_as_absent(bad_id: str) -> None:
    registry = InboundRegistry(_NoConnectStore())  # type: ignore[arg-type]
    assert asyncio.run(registry.get(ADA, bad_id)) is None
    assert asyncio.run(registry.attachments(ADA, bad_id)) == []
    assert (
        asyncio.run(
            registry.mark_remembered(
                ADA, bad_id, document_id=ABSENT, remembered_by="ada"
            )
        )
        is None
    )
    assert asyncio.run(registry.link_attachment(ADA, bad_id, ABSENT)) is False
    assert asyncio.run(registry.link_attachment(ADA, ABSENT, bad_id)) is False
    assert asyncio.run(registry.delete(ADA, bad_id)) is False


@pytest.mark.parametrize("bad_id", MALFORMED)
def test_file_registry_treats_a_malformed_id_as_absent(bad_id: str) -> None:
    registry = FileRegistry(_NoConnectStore())  # type: ignore[arg-type]
    assert asyncio.run(registry.get(ADA, bad_id)) is None
    assert (
        asyncio.run(
            registry.mark_remembered(
                ADA, bad_id, document_id=ABSENT, remembered_by="user"
            )
        )
        is None
    )


@pytest.mark.parametrize("bad_id", MALFORMED)
def test_tag_registry_treats_a_malformed_tag_id_as_absent(bad_id: str) -> None:
    tags = TagRegistry(_NoConnectStore())  # type: ignore[arg-type]
    assert asyncio.run(tags.unassign(ADA, "inbound", ABSENT, bad_id)) is False
    assert asyncio.run(tags.delete(ADA, bad_id)) is False


def _wire_incomings(monkeypatch, registry, tags=None) -> None:
    monkeypatch.setattr(incomings_api, "_resolve_principal", lambda request: _async(ADA))
    monkeypatch.setattr(incomings_api, "_registry", lambda mode=None: registry)
    monkeypatch.setattr(incomings_api, "_table_exists", lambda reg: _async(True))
    if tags is not None:
        monkeypatch.setattr(incomings_api, "_tags", lambda mode=None: tags)


class _Body:
    def __init__(self, body: dict) -> None:
        self._body = body

    async def json(self) -> dict:
        return self._body


@pytest.mark.parametrize("bad_id", MALFORMED)
def test_incomings_routes_answer_404_for_a_malformed_id(monkeypatch, bad_id) -> None:
    _wire_incomings(monkeypatch, InboundRegistry(_NoConnectStore()))  # type: ignore[arg-type]
    calls = [
        incomings_api.get_incoming(request=None, item_id=bad_id),
        incomings_api.tag_incoming(request=_Body({"name": "x"}), item_id=bad_id),
        incomings_api.untag_incoming(request=None, item_id=bad_id, tag_id=ABSENT),
        incomings_api.remember_incoming(request=None, item_id=bad_id),
    ]
    for call in calls:
        with pytest.raises(HTTPException) as excinfo:
            asyncio.run(call)
        assert excinfo.value.status_code == 404


@pytest.mark.parametrize("bad_id", MALFORMED)
def test_files_routes_answer_404_for_a_malformed_id(monkeypatch, bad_id) -> None:
    registry = FileRegistry(_NoConnectStore())  # type: ignore[arg-type]
    monkeypatch.setattr(files_api, "_resolve_principal", lambda request: _async(ADA))
    monkeypatch.setattr(files_api, "_registry", lambda mode=None: registry)
    monkeypatch.setattr(files_api, "_ensure_table", lambda reg: _async(True))
    for call in (
        files_api.get_file(request=None, asset_id=bad_id),
        files_api.get_file_link(request=None, asset_id=bad_id),
    ):
        with pytest.raises(HTTPException) as excinfo:
            asyncio.run(call)
        assert excinfo.value.status_code == 404


def test_memory_chunks_for_a_malformed_document_id_are_an_empty_page() -> None:
    class _NoQueryConn:
        def __getattr__(self, name):
            raise AssertionError("a malformed document id must not reach Postgres")

    page = asyncio.run(
        memory_explorer._rows_chunks(
            object(), ADA, _NoQueryConn(), "", "not-a-uuid", 25, 0
        )
    )
    assert page == {"rows": [], "total": 0, "limit": 25, "offset": 0}


# ---------------------------------------------------------------------------
# E2E against a real Postgres: the SQL itself no longer sees a bad cast.
# ---------------------------------------------------------------------------


def _pg_bin(name: str) -> str | None:
    found = shutil.which(name)
    if found:
        return found
    candidates = sorted(glob.glob(f"/usr/lib/postgresql/*/bin/{name}"))
    return candidates[-1] if candidates else None


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@pytest.fixture(scope="module")
def postgres_dsn(tmp_path_factory) -> Iterator[str]:
    pytest.importorskip("asyncpg")
    initdb, pg_ctl = _pg_bin("initdb"), _pg_bin("pg_ctl")
    if not initdb or not pg_ctl:
        pytest.skip("Postgres server binaries (initdb/pg_ctl) are not installed")
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        pytest.skip("initdb refuses to run as root")
    root = tmp_path_factory.mktemp("pg")
    data = root / "data"
    subprocess.run(
        [initdb, "-D", str(data), "-U", "postgres", "--auth=trust", "-E", "UTF8"],
        check=True,
        capture_output=True,
    )
    port = _free_port()
    subprocess.run(
        [
            pg_ctl, "-D", str(data), "-l", str(root / "log"), "-w", "start",
            "-o", f"-p {port} -k {root} -c listen_addresses=127.0.0.1",
        ],
        check=True,
        capture_output=True,
    )
    try:
        yield f"postgresql://postgres@127.0.0.1:{port}/postgres"
    finally:
        subprocess.run(
            [pg_ctl, "-D", str(data), "-m", "immediate", "stop"],
            check=False,
            capture_output=True,
        )


async def _real_registries(dsn: str):
    import asyncpg

    from hermes_cli.access import PrincipalStore
    from hermes_cli.datastore import get_store, initialize_supabase_app

    config = {"datastore": {"supabase_app": {"dsn": dsn}}}
    conn = await asyncpg.connect(dsn, ssl=False)
    try:
        await conn.execute("DROP SCHEMA IF EXISTS app_prod CASCADE")
        await initialize_supabase_app(conn)
    finally:
        await conn.close()
    files = FileRegistry(get_store("supabase-app", "prod", config=config))
    await files.initialize()
    inbound = InboundRegistry(get_store("supabase-app", "prod", config=config))
    await inbound.initialize()
    await inbound.tags.initialize()
    principals = PrincipalStore(get_store("supabase-app", "prod", config=config))
    await principals.enroll("leo", display="Leo", role="owner")
    await principals.enroll("ada", display="Ada")
    return inbound, files


def test_e2e_malformed_and_absent_ids_are_404_against_real_postgres(
    postgres_dsn: str, monkeypatch
) -> None:
    inbound, files = asyncio.run(_real_registries(postgres_dsn))
    item = asyncio.run(
        inbound.register(
            LEO, surface="email", external_id="msg-1", account_id="leo@x", body="hi"
        )
    )
    _wire_incomings(monkeypatch, inbound, inbound.tags)
    monkeypatch.setattr(files_api, "_resolve_principal", lambda request: _async(ADA))
    monkeypatch.setattr(files_api, "_registry", lambda mode=None: files)
    monkeypatch.setattr(files_api, "_ensure_table", lambda reg: _async(True))

    # Leo's private arrival is as invisible to Ada as a malformed id.
    for item_id in MALFORMED + [ABSENT, str(item.id)]:
        with pytest.raises(HTTPException) as excinfo:
            asyncio.run(incomings_api.get_incoming(request=None, item_id=item_id))
        assert excinfo.value.status_code == 404
        with pytest.raises(HTTPException) as excinfo:
            asyncio.run(files_api.get_file(request=None, asset_id=item_id))
        assert excinfo.value.status_code == 404

    assert asyncio.run(inbound.get(LEO, str(item.id))) is not None
    assert asyncio.run(inbound.tags.unassign(LEO, "inbound", str(item.id), "nope")) is False
    assert asyncio.run(inbound.tags.delete(LEO, "nope")) is False
