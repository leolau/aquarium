"""Fortinet VPN server half: the ``fortinet-vpn`` kind, keep-secret PUT,
no materialization, ``hermes_cli.vpn`` (helper calls, slugs, views), the
``/api/vpn`` router and ``hermes vpn``. The root helper itself is covered in
``tests/deploy/test_hermes_vpn_helper.py``; here it is faked at
``vpn.run_helper`` (or a stub executable) and the store is the file backend
in the per-test HERMES_HOME."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import stat
import sys
from pathlib import Path
from typing import Any, Dict, List

import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient

from hermes_cli import credentials_api, vpn, vpn_api, vpn_cmd
from hermes_cli.access import Principal
from hermes_cli.credential_store import (
    CREDENTIAL_KINDS,
    CredentialError,
    FileCredentialStore,
    default_credential_store,
    materialize_for_mounts,
    merge_kept_secrets,
    redact_payload,
    validate_payload,
)

OWNER = Principal(user_id="owner", display="Owner", role="owner")
ALICE = Principal(user_id="alice", display="Alice", role="member")
BOB = Principal(user_id="bob", display="Bob", role="member")
SHA = "9f2c" + "0" * 60
PAYLOAD = {
    "host": "vpn.example.com",
    "username": "alice",
    "password": "s3cret-vpn",
    "routes": ["10.20.0.0/16"],
    "share_path": "//fileserver01/Shared",
    "share_password": "s3cret-share",
}
VIEW_KEYS = {
    "name",
    "slug",
    "host",
    "port",
    "realm",
    "routes",
    "share_path",
    "mount_path",
    "auto_connect",
    "idle_minutes",
    "visibility",
    "owner_user_id",
    "trusted_cert",
    "status",
}
STATUS_KEYS = {"state", "since", "local_ip", "error", "share_error", "last_used", "last_check"}


def run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def file_store():
    store = default_credential_store()
    assert isinstance(store, FileCredentialStore), "tests need the file backend"
    return store


class FakeHelper:
    def __init__(self) -> None:
        self.calls: List[tuple] = []
        self.up_doc: Dict[str, Any] = {
            "state": "connected",
            "since": "2026-10-16T06:00:00Z",
            "local_ip": "10.212.134.5",
            "error": None,
        }
        self.state: Dict[str, Dict[str, Any]] = {}
        self.check_doc: Dict[str, Any] = {
            "at": "2026-10-16T06:01:00Z",
            "ok": True,
            "file_count": 1284,
            "message": "File server reachable, 1,284 files listed.",
        }

    def __call__(self, command, slug, *, spec=None):
        self.calls.append((command, slug, spec))
        if command == "up":
            self.state[slug] = dict(self.up_doc)
            return dict(self.up_doc)
        if command == "down":
            self.state[slug] = {"state": "disconnected"}
            return {"state": "disconnected"}
        current = dict(self.state.get(slug) or {"state": "disconnected"})
        if command == "check":
            if current.get("state") == "connected":
                current["check"] = dict(self.check_doc)
            return current
        return current

    def commands(self):
        return [c[0] for c in self.calls]


@pytest.fixture
def helper(monkeypatch):
    fake = FakeHelper()
    monkeypatch.setattr(vpn, "run_helper", fake)
    return fake


def put(store, principal, name="Office files", payload=None, visibility=None):
    return run(
        store.put(
            principal,
            provider="fortinet",
            name=name,
            kind="fortinet-vpn",
            payload=dict(payload or PAYLOAD),
            visibility=visibility,
        )
    )


# ---------------------------------------------------------------------------
# Kind
# ---------------------------------------------------------------------------


def test_kind_registered_with_contract_fields():
    spec = CREDENTIAL_KINDS["fortinet-vpn"]
    assert spec.required == ("host", "username", "password")
    assert set(spec.optional) == {
        "port",
        "realm",
        "trusted_cert",
        "routes",
        "share_path",
        "share_username",
        "share_password",
        "share_domain",
        "auto_connect",
        "idle_minutes",
    }
    assert set(spec.secret_fields) == {"password", "share_password"}
    assert spec.keep_secrets_on_put and not spec.materialize


def test_full_payload_validates():
    validate_payload(
        "fortinet-vpn",
        {
            **PAYLOAD,
            "port": 10443,
            "realm": "staff",
            "trusted_cert": SHA,
            "share_username": "svc",
            "share_domain": "CORP",
            "auto_connect": False,
            "idle_minutes": 0,
            "share_path": r"\\fileserver01\Shared\Reports",
        },
    )


@pytest.mark.parametrize(
    "over",
    [
        {"otp": "123456"},
        {"host": ""},
        {"host": "vpn example"},
        {"port": 70000},
        {"trusted_cert": "9F:2C"},
        {"routes": ["0.0.0.0/0"]},
        {"routes": ["10.20.1.0/16"]},
        {"share_path": "fileserver01/Shared"},
        {"password": "a\nb"},
        {"auto_connect": "yes"},
        {"idle_minutes": 5000},
        {"share_username": "bob,uid=0"},
    ],
)
def test_bad_payload_rejected(over):
    with pytest.raises(CredentialError):
        validate_payload("fortinet-vpn", {**PAYLOAD, **over})


def test_redaction_drops_both_passwords():
    red = redact_payload("fortinet-vpn", {**PAYLOAD})
    assert "password" not in red and "share_password" not in red
    assert red["host"] == "vpn.example.com"


def test_merge_kept_secrets():
    existing = {**PAYLOAD}
    merged = merge_kept_secrets(
        "fortinet-vpn", {**PAYLOAD, "password": "", "share_password": None}, existing
    )
    assert (
        merged["password"] == "s3cret-vpn"
        and merged["share_password"] == "s3cret-share"
    )
    assert (
        merge_kept_secrets("fortinet-vpn", {**PAYLOAD, "password": "new"}, existing)[
            "password"
        ]
        == "new"
    )
    assert merge_kept_secrets("password", {"username": "u"}, {"password": "p"}) == {
        "username": "u"
    }


def test_vpn_entries_never_materialized(file_store):
    put(file_store, OWNER)
    run(
        file_store.put(
            OWNER,
            provider="google",
            name="me@example.com",
            kind="password",
            payload={"username": "me", "password": "pw"},
        )
    )
    paths = run(materialize_for_mounts(OWNER))
    assert paths and all("fortinet" not in p for p in paths)
    from hermes_constants import get_hermes_home

    blob = "".join(
        p.read_text()
        for p in (get_hermes_home() / "credentials-materialized").rglob("*.json")
    )
    assert "s3cret-vpn" not in blob and "s3cret-share" not in blob


# ---------------------------------------------------------------------------
# Module
# ---------------------------------------------------------------------------


def test_slug_base():
    assert vpn.slug_base("Office files") == "office-files"
    assert vpn.slug_base("  Café / HQ  ") == "cafe-hq"
    assert vpn.slug_base("辦公室").startswith("vpn-")
    assert len(vpn.slug_base("x" * 100)) <= 41


def test_slugs_stable_and_unique_across_owners(file_store):
    a = put(file_store, ALICE, visibility="private:alice")
    b = put(file_store, BOB, visibility="private:bob")
    sa, sb = vpn.slug_for(a), vpn.slug_for(b)
    assert sa == "office-files" and sb != sa and sb.startswith("office-files-")
    assert vpn.slug_for(a) == sa and vpn.slug_for(b) == sb
    assert vpn._SLUG_RE.fullmatch(sb)


def test_helper_spec_only_carries_helper_keys(file_store):
    cred = put(
        file_store, OWNER, payload={**PAYLOAD, "auto_connect": False, "port": 10443}
    )
    spec = vpn.helper_spec(cred, "office-files")
    assert spec == {
        "slug": "office-files",
        "host": "vpn.example.com",
        "port": 10443,
        "username": "alice",
        "password": "s3cret-vpn",
        "routes": ["10.20.0.0/16"],
        "share_path": "//fileserver01/Shared",
        "share_password": "s3cret-share",
        "idle_minutes": 30,
    }


def test_view_never_contains_secrets(file_store, helper):
    put(file_store, OWNER)
    views = run(vpn.list_views(OWNER))
    assert len(views) == 1
    view = views[0]
    assert set(view) == VIEW_KEYS and set(view["status"]) == STATUS_KEYS
    assert "s3cret" not in json.dumps(view)
    assert view["mount_path"] == "/opt/data/vpn-files/office-files"
    assert (
        view["port"] == 443
        and view["auto_connect"] is True
        and view["idle_minutes"] == 30
    )


def test_visibility_private_entry_hidden_from_others(file_store, helper):
    put(file_store, ALICE, visibility="private:alice")
    assert run(vpn.list_views(BOB)) == []
    with pytest.raises(vpn.VpnNotFound):
        run(vpn.connect(BOB, "Office files"))
    assert len(run(vpn.list_views(ALICE))) == 1


def _stub_helper(tmp_path, monkeypatch, body: str):
    script = tmp_path / "fake-helper"
    record = tmp_path / "record.json"
    script.write_text(
        f"#!{sys.executable}\nimport json, os, sys\nRECORD = {str(record)!r}\n{body}"
    )
    script.chmod(0o755)
    monkeypatch.setattr(vpn, "HELPER_PATH", str(script))
    monkeypatch.setattr(vpn, "_helper_argv", lambda args: [str(script), *args])
    return record


def test_run_helper_writes_private_spec_and_cleans_up(tmp_path, monkeypatch):
    record = _stub_helper(
        tmp_path,
        monkeypatch,
        """
path = sys.argv[2]
st, dst = os.stat(path), os.stat(os.path.dirname(path))
json.dump({"argv": sys.argv[1:], "spec": json.load(open(path)),
           "mode": st.st_mode & 0o777, "dir_mode": dst.st_mode & 0o777}, open(RECORD, "w"))
print(json.dumps({"state": "connected"}))
""",
    )
    doc = vpn.run_helper(
        "up", "office-files", spec={"slug": "office-files", "password": "pw"}
    )
    assert doc == {"state": "connected"}
    seen = json.loads(record.read_text())
    assert (
        seen["argv"][0] == "up" and seen["mode"] == 0o600 and seen["dir_mode"] == 0o700
    )
    assert seen["spec"]["password"] == "pw"
    assert not os.path.exists(seen["argv"][1]) and not os.path.exists(
        os.path.dirname(seen["argv"][1])
    )


def test_run_helper_bad_input_raises(tmp_path, monkeypatch):
    _stub_helper(
        tmp_path,
        monkeypatch,
        'print(json.dumps({"error": "route 0.0.0.0/0 is too broad", "bad_input": True})); sys.exit(2)\n',
    )
    with pytest.raises(vpn.VpnError, match="too broad"):
        vpn.run_helper("up", "office-files", spec={"slug": "office-files"})


def test_run_helper_sudo_refusal_is_an_error_state(tmp_path, monkeypatch):
    _stub_helper(
        tmp_path,
        monkeypatch,
        'print("sudo: a password is required", file=sys.stderr); sys.exit(1)\n',
    )
    doc = vpn.run_helper("status", "office-files")
    assert doc["state"] == "error" and "sudoers" in doc["error"]


def test_run_helper_missing(monkeypatch, tmp_path):
    monkeypatch.setattr(vpn, "HELPER_PATH", str(tmp_path / "nope"))
    doc = vpn.run_helper("status", "office-files")
    assert doc["state"] == "error" and "not installed" in doc["error"]
    with pytest.raises(vpn.VpnError):
        vpn.run_helper("status", "../etc")


def test_run_helper_against_real_helper_as_non_root(monkeypatch):
    if os.geteuid() == 0:
        pytest.skip("checks the non-root refusal")
    real = Path(__file__).resolve().parents[2] / "deploy" / "hermes-vpn-helper"
    monkeypatch.setattr(vpn, "HELPER_PATH", str(real))
    monkeypatch.setattr(
        vpn, "_helper_argv", lambda args: [sys.executable, str(real), *args]
    )
    doc = vpn.run_helper("status", "office-files")
    assert doc["state"] == "error" and "must run as root" in doc["error"]


def test_sudo_used_when_not_root(monkeypatch):
    monkeypatch.setattr(vpn.os, "geteuid", lambda: 996)
    assert vpn._helper_argv(["status", "x"])[:3] == ["sudo", "-n", vpn.HELPER_PATH]
    monkeypatch.setattr(vpn.os, "geteuid", lambda: 0)
    assert vpn._helper_argv(["status", "x"])[0] == vpn.HELPER_PATH


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------


@pytest.fixture
def client(monkeypatch):
    holder = {"principal": OWNER}

    async def fake_principal(request, *, allow_as):
        return holder["principal"]

    monkeypatch.setattr(credentials_api, "_principal", fake_principal)
    app = FastAPI()
    app.include_router(credentials_api.router)
    app.include_router(vpn_api.router)
    c = TestClient(app)
    c.holder = holder  # type: ignore[attr-defined]
    return c


def put_http(client, payload, name="Office files", visibility=None):
    body: Dict[str, Any] = {"kind": "fortinet-vpn", "payload": payload}
    if visibility:
        body["visibility"] = visibility
    return client.put(f"/api/credentials/fortinet/{name}", json=body)


def test_put_redacts_and_edit_keeps_secrets(client, file_store):
    r = put_http(client, PAYLOAD, visibility="private:owner")
    assert r.status_code == 200, r.text
    assert "s3cret" not in r.text
    edit = {k: v for k, v in PAYLOAD.items() if k not in ("password", "share_password")}
    r = put_http(
        client,
        {**edit, "password": "", "routes": ["10.30.0.0/16"]},
        visibility="private:owner",
    )
    assert r.status_code == 200, r.text
    stored = run(file_store.get(OWNER, "fortinet", "Office files"))
    assert stored.payload["password"] == "s3cret-vpn"
    assert stored.payload["share_password"] == "s3cret-share"
    assert stored.payload["routes"] == ["10.30.0.0/16"]
    r = put_http(client, {**edit, "password": "rotated"})
    assert (
        run(file_store.get(OWNER, "fortinet", "Office files")).payload["password"]
        == "rotated"
    )


def test_put_new_entry_without_password_is_400(client):
    edit = {k: v for k, v in PAYLOAD.items() if k != "password"}
    assert put_http(client, edit).status_code == 400


def test_put_bad_field_is_400(client):
    r = put_http(client, {**PAYLOAD, "routes": ["0.0.0.0/0"]})
    assert r.status_code == 400 and "too broad" in r.json()["detail"]


def test_delete_disconnects_first(client, helper):
    put_http(client, PAYLOAD)
    client.post("/api/vpn/Office files/connect")
    r = client.delete("/api/credentials/fortinet/Office files")
    assert r.status_code == 200
    assert helper.calls[-1][:2] == ("down", "office-files")
    assert client.get("/api/vpn").json() == {"vpns": []}


def test_list_and_connect(client, helper):
    put_http(client, PAYLOAD)
    r = client.get("/api/vpn")
    assert r.status_code == 200
    (view,) = r.json()["vpns"]
    assert set(view) == VIEW_KEYS and view["status"]["state"] == "disconnected"
    r = client.post("/api/vpn/Office files/connect")
    assert r.status_code == 200
    v = r.json()["vpn"]
    assert (
        v["status"]["state"] == "connected"
        and v["status"]["local_ip"] == "10.212.134.5"
    )
    assert v["status"]["last_used"]
    assert "s3cret" not in r.text
    spec = [c for c in helper.calls if c[0] == "up"][0][2]
    assert spec["password"] == "s3cret-vpn" and "auto_connect" not in spec


def test_connect_failure_is_200_error_state(client, helper):
    put_http(client, PAYLOAD)
    helper.up_doc = {
        "state": "error",
        "error": "Login failed: wrong username or password",
    }
    r = client.post("/api/vpn/Office files/connect")
    assert r.status_code == 200
    assert r.json()["vpn"]["status"] == {
        "state": "error",
        "since": None,
        "local_ip": None,
        "error": "Login failed: wrong username or password",
        "share_error": None,
        "last_used": None,
        "last_check": None,
    }


def test_needs_cert_includes_cert(client, helper):
    put_http(client, PAYLOAD)
    cert = {
        "subject": "FGT60F-Office",
        "issuer": "Fortinet_CA_SSL",
        "not_after": "2027-03-31T00:00:00Z",
        "sha256": SHA,
    }
    helper.up_doc = {"state": "needs_cert", "error": "not trusted", "cert": cert}
    status = client.post("/api/vpn/Office files/connect").json()["vpn"]["status"]
    assert status["state"] == "needs_cert" and status["cert"] == cert


def test_unknown_name_404(client, helper):
    for verb in ("connect", "disconnect", "test"):
        assert client.post(f"/api/vpn/Nope/{verb}").status_code == 404
    assert client.post("/api/vpn/Nope/trust", json={"sha256": SHA}).status_code == 404


def test_helper_rejection_is_400(client, monkeypatch):
    put_http(client, PAYLOAD)

    def reject(command, slug, *, spec=None):
        if command == "up":
            raise vpn.VpnError("route 10.20.0.0/16 overlaps this server's network")
        return {"state": "disconnected"}

    monkeypatch.setattr(vpn, "run_helper", reject)
    r = client.post("/api/vpn/Office files/connect")
    assert r.status_code == 400 and "overlaps" in r.json()["detail"]


def test_trust_stores_cert_then_connects(client, helper, file_store):
    put_http(client, PAYLOAD)
    pretty = ":".join(SHA[i : i + 2].upper() for i in range(0, 64, 2))
    r = client.post("/api/vpn/Office files/trust", json={"sha256": pretty})
    assert r.status_code == 200
    assert r.json()["vpn"]["trusted_cert"] == SHA
    assert (
        run(file_store.get(OWNER, "fortinet", "Office files")).payload["trusted_cert"]
        == SHA
    )
    assert [c for c in helper.calls if c[0] == "up"][-1][2]["trusted_cert"] == SHA


def test_trust_bad_digest_400(client, helper):
    put_http(client, PAYLOAD)
    assert (
        client.post("/api/vpn/Office files/trust", json={"sha256": "abc"}).status_code
        == 400
    )
    assert client.post("/api/vpn/Office files/trust", json=["x"]).status_code == 400


def test_trust_by_non_owner_400(client, helper):
    put_http(client, PAYLOAD, visibility="shared")
    client.holder["principal"] = ALICE
    assert (
        client.post("/api/vpn/Office files/trust", json={"sha256": SHA}).status_code
        == 400
    )


def test_test_connects_then_checks(client, helper):
    put_http(client, PAYLOAD)
    r = client.post("/api/vpn/Office files/test")
    assert r.status_code == 200
    status = r.json()["vpn"]["status"]
    assert helper.commands() == ["status", "up", "check"]
    assert status["state"] == "connected"
    assert (
        status["last_check"]["file_count"] == 1284
        and status["last_check"]["ok"] is True
    )
    assert (
        client.get("/api/vpn").json()["vpns"][0]["status"]["last_check"]["ok"] is True
    )


def test_test_retries_up_when_the_share_failed_on_a_live_tunnel(client, helper):
    put_http(client, PAYLOAD)
    helper.up_doc = dict(helper.up_doc, share_error="File share login failed")
    client.post("/api/vpn/Office files/connect")
    status = client.get("/api/vpn").json()["vpns"][0]["status"]
    assert status["state"] == "connected" and status["share_error"] == "File share login failed"
    helper.up_doc = dict(helper.up_doc, share_error=None)
    helper.calls.clear()
    status = client.post("/api/vpn/Office files/test").json()["vpn"]["status"]
    assert helper.commands() == ["status", "up", "check"]
    assert status["share_error"] is None and status["last_check"]["ok"] is True


def test_test_when_connect_fails_records_failed_check(client, helper):
    put_http(client, PAYLOAD)
    helper.up_doc = {
        "state": "error",
        "error": "Can't reach the VPN server vpn.example.com:443",
    }
    status = client.post("/api/vpn/Office files/test").json()["vpn"]["status"]
    assert status["state"] == "error"
    assert (
        status["last_check"]["ok"] is False
        and "Can't reach" in status["last_check"]["message"]
    )


def test_disconnect(client, helper):
    put_http(client, PAYLOAD)
    client.post("/api/vpn/Office files/connect")
    v = client.post("/api/vpn/Office files/disconnect").json()["vpn"]
    assert v["status"]["state"] == "disconnected"


def test_router_mounted_in_web_server():
    from hermes_cli.web_server import app

    paths = {getattr(r, "path", "") for r in app.routes}
    for path in (
        "/api/vpn",
        "/api/vpn/{name}/connect",
        "/api/vpn/{name}/disconnect",
        "/api/vpn/{name}/test",
        "/api/vpn/{name}/trust",
    ):
        assert path in paths


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def cli(*argv) -> int:
    parser = argparse.ArgumentParser(prog="hermes")
    vpn_cmd.register_vpn_subparser(parser.add_subparsers(dest="command"))
    args = parser.parse_args(["vpn", *argv])
    return args.func(args)


def test_cli_up_connects(file_store, helper, capsys):
    put(file_store, OWNER)
    assert cli("up", "office files") == 0
    out = capsys.readouterr().out.strip()
    assert (
        out
        == "Office files: connected — files at /opt/data/vpn-files/office-files (read-only)"
    )


def test_cli_up_respects_auto_connect(file_store, helper, capsys):
    put(file_store, OWNER, payload={**PAYLOAD, "auto_connect": False})
    assert cli("up", "Office files") == 1
    assert (
        capsys.readouterr().out.strip()
        == "Connect 'Office files' in Settings → In&Out, then tell me."
    )
    assert "up" not in helper.commands()


def test_cli_up_when_user_already_connected(file_store, helper, capsys):
    put(file_store, OWNER, payload={**PAYLOAD, "auto_connect": False})
    helper.state["office-files"] = dict(helper.up_doc)
    assert cli("up", "Office files") == 0


def test_cli_up_error(file_store, helper, capsys):
    put(file_store, OWNER)
    helper.up_doc = {
        "state": "error",
        "error": "Login failed: wrong username or password",
    }
    assert cli("up", "Office files") == 1
    assert (
        capsys.readouterr().out.strip()
        == "Office files: error — Login failed: wrong username or password"
    )


def test_cli_needs_cert_line(file_store, helper, capsys):
    put(file_store, OWNER)
    helper.up_doc = {"state": "needs_cert", "error": "x", "cert": {"sha256": SHA}}
    assert cli("up", "Office files") == 1
    assert "Settings → In&Out" in capsys.readouterr().out


def test_cli_list_status_down_test(file_store, helper, capsys):
    assert cli("list") == 0
    assert "No VPNs are configured" in capsys.readouterr().out
    put(file_store, OWNER)
    assert cli("list") == 0
    assert capsys.readouterr().out.strip() == "Office files: disconnected"
    assert cli("list", "--json") == 0
    assert json.loads(capsys.readouterr().out)["vpns"][0]["slug"] == "office-files"
    assert cli("test", "office-files") == 0
    assert (
        "check: File server reachable, 1,284 files listed." in capsys.readouterr().out
    )
    assert cli("status", "Office files") == 0
    assert "connected" in capsys.readouterr().out
    assert cli("down", "Office files") == 0
    assert capsys.readouterr().out.strip() == "Office files: disconnected"
    assert cli("up", "Nope") == 1
    assert "no VPN named" in capsys.readouterr().err


def test_cli_registered_in_main():
    from hermes_cli import main as hermes_main

    assert "vpn" in hermes_main._BUILTIN_SUBCOMMANDS
    source = Path(hermes_main.__file__).read_text(encoding="utf-8")
    assert "register_vpn_subparser(subparsers)" in source


def test_skill_present():
    skill = (
        Path(__file__).resolve().parents[2]
        / "skills"
        / "productivity"
        / "fortinet-vpn"
        / "SKILL.md"
    )
    text = skill.read_text(encoding="utf-8")
    assert text.startswith("---\nname: fortinet-vpn\n")
    assert 'hermes vpn up "<name>"' in text and "hermes vpn down" in text
    assert stat.S_ISREG(skill.stat().st_mode)


# ---------------------------------------------------------------------------
# Connection-only VPNs (no routes, no share)
# ---------------------------------------------------------------------------

BARE = {"host": "vpn.example.com", "username": "alice", "password": "s3cret-vpn"}


def test_connection_only_payload_validates_and_spec_has_no_routes(file_store):
    validate_payload("fortinet-vpn", dict(BARE))
    spec = vpn.helper_spec(put(file_store, OWNER, payload=BARE), "office-files")
    assert "routes" not in spec and "share_path" not in spec
    assert spec["username"] == "alice" and spec["idle_minutes"] == 30


def test_connection_only_vpn_over_http(client, helper):
    r = put_http(client, BARE)
    assert r.status_code == 200, r.text
    v = client.post("/api/vpn/Office files/connect").json()["vpn"]
    assert v["status"]["state"] == "connected"
    assert v["routes"] == [] and v["share_path"] is None
    assert "routes" not in helper.calls[-1][2]


def test_view_routes_are_the_live_tunnel_routes(file_store, helper):
    put(file_store, OWNER)
    assert run(vpn.list_views(OWNER))[0]["routes"] == []  # disconnected
    helper.state["office-files"] = {
        **helper.up_doc, "routes": ["10.20.0.0/16", "10.99.0.5/32"],
    }
    assert run(vpn.list_views(OWNER))[0]["routes"] == ["10.20.0.0/16", "10.99.0.5/32"]


def test_cli_line_for_connected_vpn_without_share(file_store, helper, capsys):
    put(file_store, OWNER, payload=BARE)
    assert cli("up", "Office files") == 0
    out = capsys.readouterr().out
    assert "connected" in out and "folder_bridge_list_folders" in out


# ---------------------------------------------------------------------------
# hermes vpn migrate-shares
# ---------------------------------------------------------------------------


def _folders(store, principal):
    return {
        c.name: c
        for c in run(store.list(principal))
        if c.kind == "smb-folder" and c.owner_user_id == principal.user_id
    }


def test_migrate_shares_moves_share_into_a_folder(file_store, capsys):
    put(file_store, ALICE, payload={**PAYLOAD, "share_path": r"\\192.168.0.91\Share-Folder"},
        visibility="private:alice")
    put(file_store, BOB, name="Bare", payload=BARE, visibility="shared")

    assert cli("migrate-shares", "--dry-run") == 0
    out = capsys.readouterr().out
    assert "would move share //192.168.0.91/Share-Folder to network folder 'Share-Folder'" in out
    assert "s3cret" not in out
    assert _folders(file_store, ALICE) == {}

    assert cli("migrate-shares") == 0
    out = capsys.readouterr().out
    lines = out.strip().splitlines()
    assert len(lines) == 2 and "s3cret" not in out
    assert any(line.startswith("Bare (bob): no file share") for line in lines)
    folder = _folders(file_store, ALICE)["Share-Folder"]
    assert folder.owner_user_id == "alice" and folder.visibility == "private:alice"
    assert folder.payload == {
        "vpn": "Office files",
        "share_path": "//192.168.0.91/Share-Folder",
        "trusted_for_import": False,
        "share_username": "alice",
        "share_password": "s3cret-share",
    }
    vpn_entry = run(file_store.get(ALICE, "fortinet", "Office files"))
    assert vpn_entry.visibility == "private:alice"
    assert vpn_entry.payload == {
        "host": "vpn.example.com", "username": "alice", "password": "s3cret-vpn",
    }

    # idempotent: nothing more happens on a re-run
    assert cli("migrate-shares") == 0
    again = capsys.readouterr().out
    assert "no file share on the VPN, nothing to migrate" in again
    assert list(_folders(file_store, ALICE)) == ["Share-Folder"]


def test_migrate_shares_without_share_login_uses_the_vpn_login(file_store):
    payload = {**BARE, "routes": ["10.20.0.0/16"],
               "share_path": "//fs01/Shared/Jensen (New)"}
    put(file_store, ALICE, payload=payload, visibility="private:alice")
    lines = run(vpn.migrate_shares())
    assert lines == [
        "Office files (alice): moved share //fs01/Shared/Jensen (New) "
        "to network folder 'Jensen (New)'"
    ]
    folder = _folders(file_store, ALICE)["Jensen (New)"]
    assert "share_username" not in folder.payload and "share_password" not in folder.payload
    assert "routes" not in run(file_store.get(ALICE, "fortinet", "Office files")).payload


def test_migrate_shares_dedupes_folder_names(file_store):
    put(file_store, ALICE, name="Shared", payload=BARE, visibility="private:alice")
    run(file_store.put(ALICE, provider="fortinet", name="Shared 2", kind="smb-folder",
                       payload={"vpn": "Shared", "share_path": "//fs02/Other"}))
    put(file_store, ALICE, payload={**PAYLOAD, "share_domain": "CORP"},
        visibility="private:alice")
    lines = run(vpn.migrate_shares())
    assert any("to network folder 'Shared 3'" in line for line in lines), lines
    folder = _folders(file_store, ALICE)["Shared 3"]
    assert folder.payload["share_domain"] == "CORP"
    assert folder.payload["share_username"] == "alice"


def test_migrate_shares_reuses_a_folder_left_by_an_interrupted_run(file_store):
    put(file_store, ALICE, payload=PAYLOAD, visibility="private:alice")
    run(file_store.put(ALICE, provider="fortinet", name="Shared", kind="smb-folder",
                       payload={"vpn": "Office files", "share_path": "//fileserver01/Shared"}))
    lines = run(vpn.migrate_shares())
    assert lines == [
        "Office files (alice): moved share //fileserver01/Shared to network "
        "folder 'Shared' (already there)"
    ]
    assert list(_folders(file_store, ALICE)) == ["Shared"]
    assert "share_path" not in run(file_store.get(ALICE, "fortinet", "Office files")).payload


def test_migrate_shares_registered_in_cli():
    parser = argparse.ArgumentParser(prog="hermes")
    vpn_cmd.register_vpn_subparser(parser.add_subparsers(dest="command"))
    args = parser.parse_args(["vpn", "migrate-shares", "--dry-run"])
    assert args.vpn_command == "migrate-shares" and args.dry_run is True
