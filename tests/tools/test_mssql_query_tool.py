"""mssql_query tool: the person's own SQL Server databases (no network)."""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest

import hermes_cli.mssql_connections as ms
import tools.mssql_query_tool as tool
from tools.access_policy import acting_as

SECRET = "sql-pass-7d1e44"


def _entry(name="ERP", **over):
    payload = {"host": "sql01", "port": 1433, "database": "Sales", "username": "reader",
               "password": SECRET, "encrypt": "on"}
    payload.update(over)
    return SimpleNamespace(name=name, owner_user_id="u1", payload=payload)


@pytest.fixture
def entries(monkeypatch):
    found = [_entry()]

    async def own(principal):
        assert principal.user_id == "u1"
        return found

    async def no_route(principal, cred, *, agent=False):
        assert agent is True
        return None

    monkeypatch.setattr(ms, "own_entries", own)
    monkeypatch.setattr(ms, "route_for", no_route)
    monkeypatch.setattr(ms, "_last_test", lambda *a: None)
    return found


@pytest.fixture
def executed(monkeypatch):
    calls = []

    def fake_execute(payload, sql, *, params=None, write=False, ip=None, max_rows=500):
        calls.append({"sql": sql, "params": params, "write": write, "max_rows": max_rows})
        if write:
            return {"columns": [], "rows": [], "row_count": 0, "truncated": False, "rows_affected": 2}
        return {"columns": ["a"], "rows": [[1]], "row_count": 1, "truncated": False}

    monkeypatch.setattr(ms, "execute", fake_execute)
    return calls


def call(**args):
    with acting_as("u1", "member"):
        return json.loads(asyncio.run(tool.mssql_query_tool(args)))


def test_registered_in_the_mssql_toolset_and_gated_on_the_driver(monkeypatch):
    from tools.registry import registry

    spec = registry._tools["mssql_query"] if hasattr(registry, "_tools") else None
    if spec is not None:
        assert spec.toolset == "mssql" and spec.check_fn is tool.check_mssql_requirements
    monkeypatch.setattr(ms, "driver_available", lambda: False)
    assert tool.check_mssql_requirements() is False
    monkeypatch.setattr(ms, "driver_available", lambda: True)
    assert tool.check_mssql_requirements() is True


def test_in_api_server_toolset():
    from toolsets import _HERMES_CORE_TOOLS, resolve_toolset

    assert "mssql_query" in resolve_toolset("hermes-api-server")
    assert "mssql_query" in _HERMES_CORE_TOOLS
    assert resolve_toolset("mssql") == ["mssql_query"]


def test_needs_a_signed_in_person():
    out = json.loads(asyncio.run(tool.mssql_query_tool({"action": "list_connections"})))
    assert out["success"] is False


def test_list_connections_has_no_password(entries):
    out = call(action="list_connections")
    assert out["success"] and out["connections"][0]["name"] == "ERP"
    assert SECRET not in json.dumps(out)


def test_query_runs_read_only(entries, executed):
    out = call(action="query", sql="SELECT a FROM t WHERE id = @id", params={"id": 5}, max_rows=10)
    assert out["success"] and out["rows"] == [[1]]
    assert executed == [{"sql": "SELECT a FROM t WHERE id = %(id)s", "params": {"id": 5},
                         "write": False, "max_rows": 10}]


@pytest.mark.parametrize("sql", ["DELETE FROM t", "SELECT 1; DROP TABLE t", "EXEC sp_who"])
def test_query_refuses_writes(entries, executed, sql):
    out = call(action="query", sql=sql)
    assert out["success"] is False and executed == []


def test_write_on_read_only_connection_refused(entries, executed):
    out = call(action="query", sql="UPDATE t SET a = 1", write=True)
    assert out["success"] is False and "read-only" in out["error"] and executed == []


def test_write_needs_approval(entries, executed, monkeypatch):
    entries[0] = _entry(allow_writes=True)
    asked = []

    def deny(message, description, **kw):
        asked.append(message)
        return "decline", "user_denied"

    import tools.approval as approval

    monkeypatch.setattr(approval, "request_elicitation_consent_detailed", deny)
    out = call(action="query", sql="UPDATE t SET a = 1", write=True)
    assert out["success"] is False and "not approved" in out["error"] and executed == []
    assert "UPDATE t SET a = 1" in asked[0]

    monkeypatch.setattr(approval, "request_elicitation_consent_detailed",
                        lambda *a, **kw: ("accept", "approved"))
    out = call(action="query", sql="UPDATE t SET a = 1", write=True)
    assert out["success"] and out["rows_affected"] == 2 and executed[-1]["write"] is True


def test_list_tables_and_describe(entries, executed):
    assert call(action="list_tables")["success"]
    assert "INFORMATION_SCHEMA.TABLES" in executed[-1]["sql"]
    assert call(action="describe", table="sales.Orders")["success"]
    assert executed[-1]["params"] == {"schema": "sales", "table": "Orders"}
    assert call(action="describe")["success"] is False


def test_several_connections_need_a_name(entries, executed):
    entries.append(_entry("HR"))
    assert "several" in call(action="query", sql="SELECT 1")["error"]
    assert call(action="query", sql="SELECT 1", connection="hr")["connection"] == "HR"


def test_driver_errors_never_leak_the_password(entries, monkeypatch):
    def boom(*a, **kw):
        raise RuntimeError(f"bad thing {SECRET}")

    monkeypatch.setattr(ms, "execute", boom)
    out = call(action="query", sql="SELECT 1")
    assert out["success"] is False and SECRET not in out["error"]


def test_route_error_is_reported(entries, executed, monkeypatch):
    async def bad_route(principal, cred, *, agent=False):
        raise ms.MssqlError("VPN connect failed: nope")

    monkeypatch.setattr(ms, "route_for", bad_route)
    out = call(action="query", sql="SELECT 1")
    assert out == {"success": False, "error": "VPN connect failed: nope"}
