"""Per-person Windows servers (PowerShell over WinRM): credential kind,
owner-only API, password redaction, the VPN host route and driver wiring.

pypsrp is never used for real and nothing touches the network: the driver is
a fake module and ``check_login`` / ``execute`` are stubbed where needed.
"""

from __future__ import annotations

import asyncio
import sys
import types
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import hermes_cli.winrm_connections as wr
import hermes_cli.winrm_connections_api as api
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
SECRET = "win-pass-5a90c2"


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
        "host": "app01.corp.example", "port": 5986, "transport": "ntlm",
        "username": "CORP\\ops", "password": SECRET,
    }
    doc.update(over)
    return doc


# -- credential kind ------------------------------------------------------------


def test_kind_keeps_password_server_side():
    spec = CREDENTIAL_KINDS["winrm"]
    assert spec.secret_fields == ("password",)
    assert spec.keep_secrets_on_put and not spec.materialize


@pytest.mark.parametrize(
    "over",
    [
        {"host": "bad host"},
        {"host": ""},
        {"port": 0},
        {"port": True},
        {"transport": "basic"},
        {"username": ""},
        {"username": "a\nb"},
        {"verify_tls": "yes"},
        {"legacy_tls": 1},
    ],
)
def test_kind_rejects_bad_payloads(over):
    with pytest.raises(CredentialError):
        validate_payload("winrm", body(**over))


def test_kind_accepts_all_options():
    validate_payload("winrm", body(
        host="10.20.1.9", port=5985, transport="credssp", verify_tls=False,
        legacy_tls=True, vpn="Office VPN", label="App server",
    ))


# -- API: owner scoping + redaction ----------------------------------------------


def test_save_is_private_and_never_returns_password(file_store, as_user):
    out = run(api.put_connection("APP01", _Req(body())))["connection"]
    assert out["password_set"] is True and SECRET not in str(out)
    assert out["state"] == "untested" and out["transport"] == "ntlm"
    assert out["verify_tls"] is True and out["legacy_tls"] is False
    entry = [e for e in run(file_store.list(ALICE)) if e.provider == "winrm"][0]
    assert entry.visibility == "private:alice" and entry.kind == "winrm"
    listed = run(api.list_connections(_Req()))
    assert SECRET not in str(listed) and len(listed["connections"]) == 1
    assert "driver_available" in listed


def test_default_port_is_https():
    payload = wr._payload_from(body(port=""))
    assert payload["port"] == wr.HTTPS_PORT and wr.uses_https(payload)
    assert not wr.uses_https(body(port=5985))


@pytest.mark.parametrize("over", [{"port": "x"}, {"transport": "basic"}, {"verify_tls": "no"}])
def test_bad_fields_rejected(as_user, over):
    with pytest.raises(HTTPException) as err:
        run(api.put_connection("APP01", _Req(body(**over))))
    assert err.value.status_code == 400


def test_edit_without_password_keeps_it(file_store, as_user):
    run(api.put_connection("APP01", _Req(body())))
    run(api.put_connection("APP01", _Req(body(password="", port=5985))))
    entry = [e for e in run(file_store.list(ALICE)) if e.provider == "winrm"][0]
    assert entry.payload["password"] == SECRET and entry.payload["port"] == 5985


def test_new_server_needs_password(as_user):
    with pytest.raises(HTTPException) as err:
        run(api.put_connection("APP01", _Req(body(password=""))))
    assert err.value.status_code == 400


@pytest.mark.parametrize("name", ["", "../x", "a/b", "x" * 80])
def test_bad_names_rejected(as_user, name):
    with pytest.raises(HTTPException):
        run(api.put_connection(name, _Req(body())))


def test_unknown_vpn_rejected(as_user):
    with pytest.raises(HTTPException) as err:
        run(api.put_connection("APP01", _Req(body(vpn="Nope"))))
    assert "no VPN named" in err.value.detail


def test_nobody_else_sees_or_touches_a_server(file_store, as_user):
    run(api.put_connection("APP01", _Req(body())))
    as_user["p"] = BOB
    assert run(api.list_connections(_Req()))["connections"] == []
    for call in (
        lambda: api.test_connection("APP01", _Req()),
        lambda: api.delete_connection("APP01", _Req()),
    ):
        with pytest.raises(HTTPException) as err:
            run(call())
        assert err.value.status_code == 404
    run(api.put_connection("APP01", _Req(body(password="bobs"))))
    mine = [e for e in run(file_store.list(ALICE)) if e.provider == "winrm"
            and e.owner_user_id == "alice"][0]
    assert mine.payload["password"] == SECRET


def test_delete_own_server(as_user):
    run(api.put_connection("APP01", _Req(body())))
    assert run(api.delete_connection("APP01", _Req())) == {"deleted": True}
    assert run(api.list_connections(_Req()))["connections"] == []


def test_test_records_version_and_computer_name(as_user, monkeypatch):
    seen = {}

    def fake_execute(payload, script, *, ip=None):
        seen.update(script=script, ip=ip)
        return {"output": "5.1.17763.1\r\nAPP01\r\n", "errors": [], "had_errors": False}

    monkeypatch.setattr(wr, "execute", fake_execute)
    run(api.put_connection("APP01", _Req(body())))
    view = run(api.test_connection("APP01", _Req()))["connection"]
    assert view["state"] == "working"
    assert view["last_test"]["ps_version"] == "5.1.17763.1"
    assert view["last_test"]["computer_name"] == "APP01"
    assert "$PSVersionTable" in seen["script"] and "hostname" in seen["script"]
    assert seen["ip"] is None
    # changing the connection clears the result
    view = run(api.put_connection("APP01", _Req(body(transport="credssp"))))["connection"]
    assert view["state"] == "untested"


class AuthenticationError(Exception):
    pass


def test_check_login_failure_is_plain_and_scrubbed(monkeypatch):
    def boom(payload, script, *, ip=None):
        raise AuthenticationError(f"401 authenticating with password {SECRET}")

    monkeypatch.setattr(wr, "execute", boom)
    result = wr.check_login(body())
    assert result["ok"] is False and SECRET not in result["error"]
    assert "Sign-in failed" in result["error"]


@pytest.mark.parametrize(
    "exc, words",
    [
        (TimeoutError("slow"), "did not answer"),
        (ConnectionRefusedError("refused"), "WinRM enabled"),
        (Exception(f"weird {SECRET}"), "weird ***"),
    ],
)
def test_plain_errors_never_echo_the_password(exc, words):
    text = wr.plain_error(exc, body())
    assert words in text and SECRET not in text


def test_test_routes_through_the_vpn(as_user, monkeypatch):
    from hermes_cli import vpn

    calls = []

    async def find(principal, name, **_kw):
        assert name == "Office VPN"
        return SimpleNamespace(name=name, payload={})

    async def ensure(cred, user, host, port=None, *, agent=False):
        calls.append((user, host, port, agent))
        return {"routed": True, "ip": "10.20.1.9"}

    monkeypatch.setattr(vpn, "find_vpn", find)
    monkeypatch.setattr(vpn, "ensure_host_route", ensure)
    monkeypatch.setattr(wr, "check_login", lambda payload, *, ip=None: {"at": "x", "ok": ip == "10.20.1.9"})
    run(api.put_connection("APP01", _Req(body(vpn="Office VPN", port=5985))))
    view = run(api.test_connection("APP01", _Req()))["connection"]
    assert view["state"] == "working"
    user, host, port, agent = calls[0]
    assert user.startswith("winrm-") and host == "app01.corp.example" and port == 5985
    assert agent is False


def test_route_failure_is_reported(as_user, monkeypatch):
    from hermes_cli import vpn

    async def find(principal, name, **_kw):
        return SimpleNamespace(name=name, payload={})

    async def ensure(cred, user, host, port=None, *, agent=False):
        return {"routed": False, "error": "VPN is not connected"}

    monkeypatch.setattr(vpn, "find_vpn", find)
    monkeypatch.setattr(vpn, "ensure_host_route", ensure)
    run(api.put_connection("APP01", _Req(body(vpn="Office VPN"))))
    view = run(api.test_connection("APP01", _Req()))["connection"]
    assert view["state"] == "needs_attention"
    assert "not connected" in view["last_test"]["error"]


def test_delete_releases_the_route(as_user, monkeypatch):
    from hermes_cli import vpn

    released = []

    async def find(principal, name, **_kw):
        return SimpleNamespace(name=name, payload={})

    async def release(cred, user):
        released.append(user)

    monkeypatch.setattr(vpn, "find_vpn", find)
    monkeypatch.setattr(vpn, "release_host_route", release)
    run(api.put_connection("APP01", _Req(body(vpn="Office VPN"))))
    run(api.delete_connection("APP01", _Req()))
    assert len(released) == 1 and released[0].startswith("winrm-")


# -- driver wiring (fake pypsrp) -------------------------------------------------------


@pytest.fixture
def fake_pypsrp(monkeypatch):
    seen = {"closed": 0}

    class _Session:
        def __init__(self):
            self.mounted = {}

        def mount(self, prefix, adapter):
            self.mounted[prefix] = adapter

    class _Transport:
        def _build_session(self):
            return _Session()

    class Client:
        def __init__(self, server, **kwargs):
            seen.update(server=server, kwargs=kwargs)
            self.wsman = SimpleNamespace(transport=_Transport())
            seen["client"] = self

        def execute_ps(self, script):
            seen["script"] = script
            streams = SimpleNamespace(error=[f"denied {SECRET}"])
            return f"out {SECRET}", streams, True

        def close(self):
            seen["closed"] += 1

    pkg = types.ModuleType("pypsrp")
    client_mod = types.ModuleType("pypsrp.client")
    client_mod.Client = Client
    pkg.client = client_mod
    monkeypatch.setitem(sys.modules, "pypsrp", pkg)
    monkeypatch.setitem(sys.modules, "pypsrp.client", client_mod)
    return seen


def test_connect_passes_options(fake_pypsrp):
    wr.connect(body(port=5985, transport="kerberos", verify_tls=False))
    kw = fake_pypsrp["kwargs"]
    assert fake_pypsrp["server"] == "app01.corp.example"
    assert kw["port"] == 5985 and kw["ssl"] is False and kw["auth"] == "kerberos"
    assert kw["cert_validation"] is False and kw["password"] == SECRET
    assert "negotiate_hostname_override" not in kw


def test_connect_through_vpn_dials_ip_but_checks_host(fake_pypsrp):
    client = wr.connect(body(), ip="10.20.1.9")
    kw = fake_pypsrp["kwargs"]
    assert fake_pypsrp["server"] == "10.20.1.9" and kw["ssl"] is True
    assert kw["negotiate_hostname_override"] == "app01.corp.example"
    session = client.wsman.transport._build_session()
    adapter = session.mounted["https://"]
    import requests

    prepared = requests.Request("POST", "https://10.20.1.9:5986/wsman").prepare()
    host_params, pool = adapter.build_connection_pool_key_attributes(prepared, True)
    assert host_params["host"] == "10.20.1.9"
    assert pool["server_hostname"] == "app01.corp.example"
    assert pool["assert_hostname"] == "app01.corp.example"
    assert pool["cert_reqs"] == "CERT_REQUIRED"


def test_tls_adapter_without_verification_and_legacy():
    import ssl

    import requests

    adapter = wr.tls_adapter("app01", verify=False, legacy_tls=True)
    prepared = requests.Request("POST", "https://app01:5986/wsman").prepare()
    _, pool = adapter.build_connection_pool_key_attributes(prepared, False)
    assert pool["assert_hostname"] is False and pool["cert_reqs"] == "CERT_NONE"
    assert pool["ssl_context"].verify_mode == ssl.CERT_NONE
    assert pool["ssl_context"].minimum_version == ssl.TLSVersion.TLSv1


def test_execute_scrubs_output_and_closes(fake_pypsrp):
    result = wr.execute(body(), "Get-Date")
    assert fake_pypsrp["script"] == "Get-Date" and fake_pypsrp["closed"] == 1
    assert SECRET not in str(result) and result["had_errors"] is True
    assert result["errors"] == ["denied ***"]


def test_missing_driver_is_a_clear_503(monkeypatch):
    monkeypatch.setitem(sys.modules, "pypsrp", None)
    monkeypatch.setitem(sys.modules, "pypsrp.client", None)
    import tools.lazy_deps as lazy

    def no_install(*a, **kw):
        raise RuntimeError("no installs in tests")

    monkeypatch.setattr(lazy, "ensure", no_install)
    with pytest.raises(wr.WinrmError) as err:
        wr.connect(body())
    assert err.value.status == 503
    assert wr.driver_available() is False


def test_lazy_dep_mirrors_the_extra():
    import tomllib
    from pathlib import Path

    from tools.lazy_deps import LAZY_DEPS

    root = Path(__file__).resolve().parents[2]
    extras = tomllib.loads((root / "pyproject.toml").read_text())["project"]["optional-dependencies"]
    assert sorted(LAZY_DEPS["winrm.driver"]) == sorted(extras["winrm"])
