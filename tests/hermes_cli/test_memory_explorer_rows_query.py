"""``/api/memory/explorer/rows?q=`` — the semantic-search branch.

The search branch enriches hits with ``uses``/``last_used`` inside an
RLS-bound transaction; it must bind the principal itself rather than rely on
names imported by its caller.
"""

from __future__ import annotations

import datetime as dt
from types import SimpleNamespace

import pytest

from hermes_cli import access, memory_explorer
from hermes_cli.access import Principal

ALICE = Principal(user_id="alice", display="Alice", role="member")


class _Txn:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class _Conn:
    def __init__(self, uses_rows):
        self._uses_rows = uses_rows
        self.queries: list[str] = []

    def transaction(self):
        return _Txn()

    async def fetch(self, sql, *args):
        self.queries.append(sql)
        return self._uses_rows


class _Store:
    role_reads = ()

    def __init__(self, records):
        self._records = records

    async def query(self, principal, q, **kwargs):
        return self._records


@pytest.mark.asyncio
async def test_query_rows_bind_the_principal_and_carry_uses(monkeypatch):
    bound: list[str] = []

    async def fake_bind_principal(conn, principal):
        bound.append(principal.user_id)

    async def fake_bind_elevated(conn, role_reads):
        return None

    monkeypatch.setattr(access, "bind_principal", fake_bind_principal)
    monkeypatch.setattr(access, "bind_elevated_reads", fake_bind_elevated)

    record = SimpleNamespace(
        id="11111111-1111-1111-1111-111111111111",
        owner_user_id="alice",
        visibility="private",
        kind="fact",
        topic=None,
        text="alice likes tea",
        created_at=dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc),
        elevated=False,
        provenance=None,
        score=0.9,
        source_session=None,
    )
    last_used = dt.datetime(2026, 2, 1, tzinfo=dt.timezone.utc)
    conn = _Conn([{"id": record.id, "uses": 3, "last_used": last_used}])

    out = await memory_explorer._rows_with_query(
        _Store([record]), ALICE, conn, "tea", "", "", "", 6, 0
    )

    assert bound == ["alice"]
    assert out["total"] == 1
    row = out["rows"][0]
    assert row["id"] == record.id
    assert row["uses"] == 3
    assert row["last_used"] == last_used.isoformat()
