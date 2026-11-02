"""Per-person SQL Server connections: credential kind, owner-only API,
password redaction, read-only guard, result limits and the VPN host route.

python-tds is never imported for real and nothing touches the network: the
driver is a fake module and ``connect`` is stubbed where a login is needed.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import decimal
import sys
import types
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import hermes_cli.mssql_connections as ms
import hermes_cli.mssql_connections_api as api
from hermes_cli.access import Principal
from hermes_cli.credential_store import (
    CREDENTIAL_KINDS,
    CredentialError,
    FileCredentialStore,
    default_credential_store,
    validate_payload,
)

ALICE = Principal(user_id="alice", display="Alice", role="member")
BOB = Principal(user_id="bob", display="Bob", role="admin")
SECRET = "sql-pass-7d1e44"


def run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def file_store():
    store = default_credential_store()
    assert isinstance(store, FileCredentialStore), "tests need the file backend"
    return store


class _Req:
    def __init__(self, doc=None):
        self._doc = doc

    async def json(self):
        return self._doc


@pytest.fixture
def as_user(monkeypatch):
    current = {"p": ALICE}

    async def _caller(_request):
        return current["p"]

    monkeypatch.setattr(api, "_caller", _caller)
    return current


def body(**over):
    doc = {
        "host": "sql01.corp.example", "port": 1433, "database": "Sales",
        "username": "reader", "password": SECRET, "encrypt": "on",
    }
    doc.update(over)
    return doc


# -- credential kind ------------------------------------------------------------


def test_kind_keeps_password_server_side():
    spec = CREDENTIAL_KINDS["mssql"]
    assert spec.secret_fields == ("password",)
    assert spec.keep_secrets_on_put and not spec.materialize


@pytest.mark.parametrize(
    "over",
    [
        {"host": "bad host"},
        {"host": ""},
        {"port": 0},
        {"port": True},
        {"instance": "bad instance"},
        {"encrypt": "maybe"},
        {"database": ""},
        {"username": "a\nb"},
        {"allow_writes": "yes"},
        {"encrypt": "strict", "trust_server_certificate": True},
        {"unknown": 1},
    ],
)
def test_kind_rejects_bad_payloads(over):
    payload = body(**over)
    with pytest.raises(CredentialError):
        validate_payload("mssql", payload)


def test_kind_accepts_old_server_options():
    validate_payload("mssql", body(
        host="10.20.1.9", instance="SQLEXPRESS", port=None, legacy_tls=True,
        trust_server_certificate=True, vpn="Office VPN", allow_writes=False, label="ERP",
    ) | {"port": 1433})


# -- API: owner scoping + redaction ----------------------------------------------


def test_save_is_private_and_never_returns_password(file_store, as_user):
    out = run(api.put_connection("ERP", _Req(body())))["connection"]
    assert out["password_set"] is True and SECRET not in str(out)
    assert out["state"] == "untested" and out["encrypt"] == "on"
    stored = run(file_store.list(ALICE))
    entry = [e for e in stored if e.provider == "mssql"][0]
    assert entry.visibility == "private:alice"
    listed = run(api.list_connections(_Req()))
    assert SECRET not in str(listed) and len(listed["connections"]) == 1


def test_edit_without_password_keeps_it(file_store, as_user):
    run(api.put_connection("ERP", _Req(body())))
    run(api.put_connection("ERP", _Req(body(password="", database="Ops"))))
    entry = [e for e in run(file_store.list(ALICE)) if e.provider == "mssql"][0]
    assert entry.payload["password"] == SECRET and entry.payload["database"] == "Ops"


def test_new_connection_needs_password(as_user):
    with pytest.raises(HTTPException) as err:
        run(api.put_connection("ERP", _Req(body(password=""))))
    assert err.value.status_code == 400


@pytest.mark.parametrize("name", ["", "../x", "a/b", "x" * 80])
def test_bad_names_rejected(as_user, name):
    with pytest.raises(HTTPException):
        run(api.put_connection(name, _Req(body())))


def test_only_the_owner_can_allow_changes(as_user):
    with pytest.raises(HTTPException) as err:
        run(api.put_connection("ERP", _Req(body(allow_writes=True))))
    assert err.value.status_code == 403
    as_user["p"] = Principal(user_id="olga", display="Olga", role="owner")
    view = run(api.put_connection("ERP", _Req(body(allow_writes=True))))["connection"]
    assert view["allow_writes"] is True


def test_unknown_vpn_rejected(as_user):
    with pytest.raises(HTTPException) as err:
        run(api.put_connection("ERP", _Req(body(vpn="Nope"))))
    assert "no VPN named" in err.value.detail


def test_nobody_else_sees_or_touches_a_connection(file_store, as_user):
    run(api.put_connection("ERP", _Req(body())))
    as_user["p"] = BOB
    assert run(api.list_connections(_Req()))["connections"] == []
    for call in (
        lambda: api.test_connection("ERP", _Req()),
        lambda: api.delete_connection("ERP", _Req()),
    ):
        with pytest.raises(HTTPException) as err:
            run(call())
        assert err.value.status_code == 404
    run(api.put_connection("ERP", _Req(body(password="bobs"))))
    as_user["p"] = ALICE
    mine = [e for e in run(file_store.list(ALICE)) if e.provider == "mssql"
            and e.owner_user_id == "alice"][0]
    assert mine.payload["password"] == SECRET


def test_delete_own_connection(as_user):
    run(api.put_connection("ERP", _Req(body())))
    assert run(api.delete_connection("ERP", _Req())) == {"deleted": True}
    assert run(api.list_connections(_Req()))["connections"] == []


def test_test_records_server_version(as_user, monkeypatch):
    seen = {}

    def fake_check(payload, *, ip=None):
        seen.update(payload=dict(payload), ip=ip)
        return {"at": "now", "ok": True, "server_version": "Microsoft SQL Server 2012", "database": "Sales"}

    monkeypatch.setattr(ms, "check_login", fake_check)
    run(api.put_connection("ERP", _Req(body())))
    view = run(api.test_connection("ERP", _Req()))["connection"]
    assert view["state"] == "working" and view["last_test"]["server_version"].endswith("2012")
    assert seen["ip"] is None
    # changing the connection clears the result
    view = run(api.put_connection("ERP", _Req(body(database="Ops"))))["connection"]
    assert view["state"] == "untested"


class _LoginError(Exception):
    pass


_LoginError.__name__ = "LoginError"


def test_check_login_failure_is_plain_and_scrubbed(monkeypatch):
    def boom(payload, **_kw):
        raise _LoginError(f"Login failed for user 'reader' pw={SECRET}")

    monkeypatch.setattr(ms, "connect", boom)
    out = ms.check_login(body())
    assert out["ok"] is False and "Sign-in failed" in out["error"]
    assert SECRET not in str(out)


def test_scrub_removes_password_from_any_error(monkeypatch):
    def boom(payload, **_kw):
        raise RuntimeError(f"weird {SECRET} failure")

    monkeypatch.setattr(ms, "connect", boom)
    out = ms.check_login(body())
    assert SECRET not in out["error"] and "***" in out["error"]


# -- VPN host route ---------------------------------------------------------------


def test_test_routes_through_the_vpn(as_user, monkeypatch):
    from hermes_cli import vpn

    vpn_cred = SimpleNamespace(name="Office VPN", payload={})
    calls = []

    async def find(principal, name, **_kw):
        assert name == "Office VPN"
        return vpn_cred

    async def ensure(cred, user, host, port=None, *, agent=False):
        calls.append((user, host, port, agent))
        return {"routed": True, "ip": "10.20.1.9"}

    monkeypatch.setattr(vpn, "find_vpn", find)
    monkeypatch.setattr(vpn, "ensure_host_route", ensure)
    monkeypatch.setattr(ms, "check_login", lambda payload, *, ip=None: {"at": "x", "ok": ip == "10.20.1.9"})
    run(api.put_connection("ERP", _Req(body(vpn="Office VPN"))))
    view = run(api.test_connection("ERP", _Req()))["connection"]
    assert view["state"] == "working"
    user, host, port, agent = calls[0]
    assert user.startswith("mssql-") and host == "sql01.corp.example" and port == 1433
    assert agent is False


def test_route_failure_is_reported(as_user, monkeypatch):
    from hermes_cli import vpn

    async def find(principal, name, **_kw):
        return SimpleNamespace(name=name, payload={})

    async def ensure(*_a, **_kw):
        return {"routed": False, "error": "VPN connect failed: bad password"}

    monkeypatch.setattr(vpn, "find_vpn", find)
    monkeypatch.setattr(vpn, "ensure_host_route", ensure)
    run(api.put_connection("ERP", _Req(body(vpn="Office VPN"))))
    view = run(api.test_connection("ERP", _Req()))["connection"]
    assert view["state"] == "needs_attention"
    assert view["last_test"]["error"] == "VPN connect failed: bad password"


def _vpn_fakes(monkeypatch, state, connect_state="connected"):
    from hermes_cli import vpn

    helper_calls = []

    async def helper(command, slug, spec=None):
        helper_calls.append((command, slug, spec))
        if command == "status":
            return {"state": state}
        return {"routed": True, "ip": "10.20.1.9", "reachable": True, "error": None}

    async def connect(cred):
        helper_calls.append(("up", "office", None))
        return {"status": {"state": connect_state, "error": "boom"}}

    monkeypatch.setattr(vpn, "_helper", helper)
    monkeypatch.setattr(vpn, "_connect", connect)
    monkeypatch.setattr(vpn, "slug_for", lambda cred: "office")
    monkeypatch.setattr(vpn, "_record", lambda slug, **kw: {})
    return vpn, helper_calls


def test_ensure_host_route_connects_then_routes(monkeypatch):
    vpn, calls = _vpn_fakes(monkeypatch, "disconnected")
    cred = SimpleNamespace(name="Office VPN", payload={})
    doc = run(vpn.ensure_host_route(cred, "mssql-abc", "sql01", 1433))
    assert doc["routed"] is True and doc["ip"] == "10.20.1.9"
    assert [c[0] for c in calls] == ["status", "up", "route"]
    assert calls[-1][2] == {"vpn_slug": "office", "user": "mssql-abc", "host": "sql01", "port": 1433}


def test_ensure_host_route_honours_auto_connect_off_for_agents(monkeypatch):
    vpn, calls = _vpn_fakes(monkeypatch, "disconnected")
    cred = SimpleNamespace(name="Office VPN", payload={"auto_connect": False})
    doc = run(vpn.ensure_host_route(cred, "mssql-abc", "sql01", agent=True))
    assert doc["routed"] is False and "Connect 'Office VPN'" in doc["error"]
    assert [c[0] for c in calls] == ["status"]


def test_ensure_host_route_reports_failed_connect(monkeypatch):
    vpn, calls = _vpn_fakes(monkeypatch, "disconnected", connect_state="error")
    cred = SimpleNamespace(name="Office VPN", payload={})
    doc = run(vpn.ensure_host_route(cred, "mssql-abc", "sql01"))
    assert doc["routed"] is False and doc["error"] == "VPN connect failed: boom"


def test_delete_releases_the_route(as_user, monkeypatch):
    from hermes_cli import vpn

    released = []

    async def find(principal, name, **_kw):
        return SimpleNamespace(name=name, payload={})

    async def release(cred, user):
        released.append(user)

    monkeypatch.setattr(vpn, "find_vpn", find)
    monkeypatch.setattr(vpn, "release_host_route", release)
    run(api.put_connection("ERP", _Req(body(vpn="Office VPN"))))
    run(api.delete_connection("ERP", _Req()))
    assert len(released) == 1 and released[0].startswith("mssql-")


# -- driver wiring (fake python-tds) -------------------------------------------------


@pytest.fixture
def fake_pytds(monkeypatch):
    seen = {}
    pytds = types.ModuleType("pytds")
    tls = types.ModuleType("pytds.tls")
    tls.create_context = lambda cafile: "default-ctx"
    pytds.tls = tls

    def connect(**kwargs):
        seen["kwargs"] = kwargs
        seen["ctx"] = pytds.tls.create_context(kwargs.get("cafile"))
        return "conn"

    pytds.connect = connect
    monkeypatch.setitem(sys.modules, "pytds", pytds)
    monkeypatch.setitem(sys.modules, "pytds.tls", tls)
    monkeypatch.setattr(ms, "_tls_hooked", False)
    monkeypatch.setattr(ms, "_tls_context", lambda settings: ("ctx", dict(settings)))
    return seen


def test_connect_passes_options_and_its_own_tls_context(fake_pytds):
    assert ms.connect(body(legacy_tls=True)) == "conn"
    kw = fake_pytds["kwargs"]
    assert kw["dsn"] == "sql01.corp.example" and kw["port"] == 1433
    assert kw["login_timeout"] == 15 and kw["timeout"] == 30 and kw["autocommit"] is False
    assert kw["validate_host"] is True and kw["enc_login_only"] is False
    ctx, settings = fake_pytds["ctx"]
    assert ctx == "ctx" and settings["legacy_tls"] is True and settings["verify"] is True
    # the override is thread-local and cleared afterwards
    assert sys.modules["pytds.tls"].create_context("x") == "default-ctx"


def test_connect_named_instance_and_trust(fake_pytds):
    ms.connect(body(instance="SQLEXPRESS", port=None, trust_server_certificate=True))
    kw = fake_pytds["kwargs"]
    assert kw["dsn"] == "sql01.corp.example\\SQLEXPRESS" and kw["port"] is None
    assert kw["validate_host"] is False


def test_connect_through_vpn_dials_ip_but_checks_host(fake_pytds, monkeypatch):
    dialed = []

    class Sock:
        def close(self):
            pass

    monkeypatch.setattr(ms.socket, "create_connection", lambda addr, timeout: dialed.append(addr) or Sock())
    ms.connect(body(), ip="10.20.1.9")
    kw = fake_pytds["kwargs"]
    assert dialed == [("10.20.1.9", 1433)] and kw["dsn"] == "sql01.corp.example"
    assert isinstance(kw["sock"], Sock)


@pytest.mark.parametrize(
    "payload, verify, login_only",
    [
        ({"encrypt": "on"}, True, False),
        ({"encrypt": "on", "trust_server_certificate": True}, False, False),
        ({"encrypt": "strict", "trust_server_certificate": True}, True, False),
        ({"encrypt": "off"}, False, True),
    ],
)
def test_tls_settings(payload, verify, login_only):
    settings = ms.tls_settings(payload)
    assert settings["verify"] is verify and settings["login_only"] is login_only


def test_real_tls_context_builds_when_pyopenssl_is_installed():
    pytest.importorskip("OpenSSL")
    assert ms._tls_context({"legacy_tls": True, "verify": False}) is not None
    assert ms._tls_context({"legacy_tls": False, "verify": True}) is not None


# -- read-only guard ---------------------------------------------------------------------


@pytest.mark.parametrize(
    "sql",
    [
        "SELECT * FROM dbo.Orders",
        "select top 10 name from sys.tables;",
        "WITH x AS (SELECT 1 AS a) SELECT a FROM x",
        "SELECT 'drop table x; delete' AS note",
        "SELECT [Update], [Delete] FROM dbo.T -- DROP TABLE x",
        "/* exec */ SELECT 1",
        "SELECT N'INSERT INTO'",
    ],
)
def test_read_only_allows(sql):
    ms.check_read_only(sql)


@pytest.mark.parametrize(
    "sql",
    [
        "INSERT INTO t VALUES (1)",
        "UPDATE t SET a = 1",
        "DELETE FROM t",
        "DROP TABLE t",
        "EXEC sp_who",
        "SELECT 1; DROP TABLE t",
        "SELECT 1; SELECT 2",
        "SELECT * INTO copy FROM t",
        "WITH x AS (SELECT 1 a) DELETE FROM t",
        "SELECT * FROM OPENROWSET('SQLNCLI', 'x', 'y')",
        "SELECT master.dbo.xp_cmdshell('dir')",
        "TRUNCATE TABLE t",
        "MERGE t USING s ON 1=1 WHEN MATCHED THEN DELETE;",
        "SHUTDOWN",
        "GRANT SELECT ON t TO x",
        "SELECT 'unterminated",
        "",
    ],
)
def test_read_only_denies(sql):
    with pytest.raises(ms.MssqlError):
        ms.check_read_only(sql)


def test_write_guard():
    ms.check_write("UPDATE dbo.T SET a = 1 WHERE id = 2")
    for sql in ("SHUTDOWN", "UPDATE t SET a=1; DROP TABLE t", "EXEC xp_cmdshell 'dir'", "BACKUP DATABASE x TO DISK='y'"):
        with pytest.raises(ms.MssqlError):
            ms.check_write(sql)


# -- limits ------------------------------------------------------------------------------


def test_row_cell_and_size_limits():
    rows = [(i, "x" * 3000) for i in range(600)]
    out = ms.shape_rows(["id", "big"], rows, max_rows=500)
    assert out["truncated"] is True
    assert len(out["rows"][0][1]) == ms.MAX_CELL_CHARS + 1
    assert len(str(out)) < ms.MAX_RESULT_BYTES * 1.1
    small = ms.shape_rows(["a"], [(1,), (2,)])
    assert small == {"columns": ["a"], "rows": [[1], [2]], "row_count": 2, "truncated": False}


def test_cells_are_json_safe():
    out = ms.shape_rows(["a", "b", "c", "d"], [(decimal.Decimal("1.50"), dt.date(2026, 1, 2), b"\x01\x02", None)])
    assert out["rows"] == [["1.50", "2026-01-02", "0x0102", None]]


class _Cursor:
    def __init__(self, rows, columns=("a",)):
        self.rows, self.description = rows, [(c,) for c in columns]
        self.executed, self.rowcount = [], 3

    def execute(self, sql, params=None):
        self.executed.append((sql, params))

    def fetchmany(self, n):
        return self.rows[:n]

    def close(self):
        pass


class _Conn:
    def __init__(self, cursor):
        self.cur, self.commits, self.rollbacks, self.closed = cursor, 0, 0, False

    def cursor(self):
        return self.cur

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1

    def close(self):
        self.closed = True


def test_execute_reads_inside_a_rolled_back_transaction(monkeypatch):
    conn = _Conn(_Cursor([(i,) for i in range(700)]))
    monkeypatch.setattr(ms, "connect", lambda payload, ip=None: conn)
    out = ms.execute(body(), "SELECT a FROM t")
    assert out["row_count"] == 500 and out["truncated"] is True
    assert conn.cur.executed[0][0] == "SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED"
    assert conn.rollbacks == 1 and conn.commits == 0 and conn.closed


def test_execute_write_needs_allow_writes(monkeypatch):
    conn = _Conn(_Cursor([], columns=()))
    monkeypatch.setattr(ms, "connect", lambda payload, ip=None: conn)
    with pytest.raises(ms.MssqlError):
        ms.execute(body(), "UPDATE t SET a = 1", write=True)
    out = ms.execute(body(allow_writes=True), "UPDATE t SET a = 1", write=True)
    assert out["rows_affected"] == 3 and conn.commits == 1
