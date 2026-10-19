"""Get ready → Security basics (hermes_cli/security_basics.py + its API).

Real paths where it matters: a real TLS handshake against a local server with
a test CA, the real config.yaml for ``terminal.run_as``, a fake ``sudo`` on
PATH for the helper call, and real requests through the dashboard app as a
member, viewer, admin and owner against a temp HERMES_HOME."""

from __future__ import annotations

import json
import os
import socket
import ssl
import stat
import subprocess
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

from hermes_cli import security_basics as sb

OWNER = SimpleNamespace(user_id="root", display="Owner", role="owner", is_owner=True)
ADMIN = SimpleNamespace(user_id="ann", display="Ann", role="admin", is_owner=False)
MEMBER = SimpleNamespace(user_id="mia", display="Mia", role="member", is_owner=False)
VIEWER = SimpleNamespace(user_id="tom", display="Tom", role="viewer", is_owner=False)

GOOD_REPORT = {
    "version": 1,
    "ssh": {"installed": True, "readable": True, "password_authentication": False,
            "kbd_interactive_authentication": False, "permit_root_login": "without-password",
            "permit_empty_passwords": False, "authorized_keys": 2},
    "updates": {"installed": True, "unattended_upgrade": True, "update_package_lists": True, "timer_enabled": True},
    "firewall": {"tool": "ufw", "active": True, "allow_all": False, "allowed": [22, 80, 443]},
    "ports": {"readable": True, "open": [{"port": 22, "process": "sshd", "bypasses_firewall": False},
                                         {"port": 443, "process": "caddy", "bypasses_firewall": False}]},
    "domains": [],
    "doctor": {"installed": True, "trusted": True, "ran": True, "supports_json": True,
               "rows": [{"status": "ok", "text": "disk /: 50 GB free", "fix": ""}]},
}


@pytest.fixture(autouse=True)
def _no_system_files(monkeypatch, tmp_path):
    monkeypatch.setattr(sb, "CADDYFILE", str(tmp_path / "Caddyfile"))
    monkeypatch.setattr(sb, "AQUARIUM_CONF", str(tmp_path / "aquarium.conf"))
    monkeypatch.setattr(sb, "HELPER", str(tmp_path / "no-helper"))


def _by_id(result):
    return {c["id"]: c for c in result["checks"]}


# ------------------------------------------------------------------ checks


def test_without_the_helper_root_checks_say_cant_check_and_nothing_runs(monkeypatch):
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: pytest.fail(f"ran {a}"))
    result = sb.collect()
    checks = _by_id(result)
    assert list(checks) == list(sb.CHECK_IDS)
    for cid in ("ssh", "updates", "ports", "doctor"):
        assert checks[cid] == {"id": cid, "status": "unknown", "facts": {"reason": "helper_missing"}}
    assert checks["tls"]["facts"] == {"reason": "no_domain"}
    assert checks["two_factor"]["status"] == "unavailable"
    assert result["helper"] == "missing" and result["status"] == "attention"
    assert result["total"] == 6  # "not available yet" is not counted


def test_all_good_report_is_done(monkeypatch):
    monkeypatch.setattr(sb, "run_helper", lambda: (GOOD_REPORT, ""))
    monkeypatch.setattr(sb, "check_tls", lambda d: sb._check("tls", sb.OK, certificates=[]))
    monkeypatch.setattr(sb, "check_tools_user", lambda: sb._check("tools_user", sb.OK, run_as="hermes-tools"))
    result = sb.collect()
    assert result["status"] == "done" and result["passed"] == result["total"] == 6


def test_weak_ssh_extra_ports_updates_off_and_doctor_failures_need_attention():
    report = json.loads(json.dumps(GOOD_REPORT))
    report["ssh"]["password_authentication"] = True
    report["updates"]["unattended_upgrade"] = False
    report["ports"]["open"].append({"port": 8000, "process": "docker-proxy", "bypasses_firewall": True})
    report["doctor"]["rows"].append({"status": "fail", "text": "service x: failed", "fix": "restart x"})
    ssh = sb.check_ssh(report, "")
    assert ssh["status"] == "attention" and ssh["facts"]["password_login"] and ssh["facts"]["authorized_keys"] == 2
    assert sb.check_updates(report, "")["status"] == "attention"
    ports = sb.check_ports(report, "")
    assert ports["status"] == "attention"
    assert ports["facts"]["extra"] == [{"port": 8000, "process": "docker-proxy", "bypasses_firewall": True}]
    doc = sb.check_doctor(report, "")
    assert doc["status"] == "attention" and doc["facts"]["failed"] == 1 and doc["facts"]["total"] == 2
    assert doc["facts"]["problems"][0]["fix"] == "restart x"


@pytest.mark.parametrize("doctor,reason", [
    ({"installed": False}, "doctor_missing"),
    ({"installed": True, "trusted": False}, "doctor_untrusted"),
    ({"installed": True, "trusted": True, "ran": False}, "doctor_timeout"),
    ({"installed": True, "trusted": True, "ran": True, "supports_json": False}, "doctor_old"),
])
def test_doctor_that_cannot_answer_is_unknown(doctor, reason):
    assert sb.check_doctor({**GOOD_REPORT, "doctor": doctor}, "") == {
        "id": "doctor", "status": "unknown", "facts": {"reason": reason}}


def test_no_ssh_server_is_fine():
    assert sb.check_ssh({**GOOD_REPORT, "ssh": {"installed": False}}, "")["status"] == "ok"


def _fake_sudo(tmp_path, monkeypatch, body):
    bin_ = tmp_path / "bin"
    bin_.mkdir(exist_ok=True)
    (bin_ / "sudo").write_text(f"#!/bin/sh\necho \"$*\" >> {tmp_path}/sudo.log\n{body}\n")
    (bin_ / "sudo").chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_}:/usr/bin:/bin")
    monkeypatch.setattr(sb, "helper_installed", lambda: True)


def test_run_helper_calls_sudo_n_with_no_arguments(tmp_path, monkeypatch):
    _fake_sudo(tmp_path, monkeypatch, f"echo '{json.dumps(GOOD_REPORT)}'")
    report, reason = sb.run_helper()
    assert reason == "" and report["ssh"]["authorized_keys"] == 2
    assert (tmp_path / "sudo.log").read_text().split() == ["-n", sb.HELPER]


@pytest.mark.parametrize("body,reason", [
    ("echo 'sudo: a password is required' >&2; exit 1", "refused"),
    ("echo '{\"version\": 1, \"error\": \"busy\"}'; exit 75", "busy"),
    ("echo garbage; exit 0", "bad_output"),
])
def test_run_helper_reasons(tmp_path, monkeypatch, body, reason):
    _fake_sudo(tmp_path, monkeypatch, body)
    assert sb.run_helper() == (None, reason)


def test_helper_must_be_root_owned_and_not_writable_by_others(tmp_path, monkeypatch):
    fake = tmp_path / "helper"
    fake.write_text("#!/bin/sh\n")
    monkeypatch.setattr(sb, "HELPER", str(fake))
    assert sb.helper_installed() is False  # owned by the test user, not root
    monkeypatch.setattr(sb, "HELPER", "/usr/bin/env")  # root-owned 0755 on Linux
    assert sb.helper_installed() is (os.stat("/usr/bin/env").st_uid == 0)


def test_tools_user_follows_terminal_run_as(monkeypatch):
    from hermes_constants import get_hermes_home
    from tools import terminal_user

    monkeypatch.setattr(terminal_user, "HELPER", "/usr/bin/env")
    assert sb.check_tools_user()["status"] == "attention"  # default: run_as empty (old boxes)
    (get_hermes_home() / "config.yaml").write_text("terminal:\n  run_as: hermes-tools\n")
    check = sb.check_tools_user()
    assert check["facts"]["run_as"] == "hermes-tools"
    assert check["status"] == ("ok" if os.stat("/usr/bin/env").st_uid == 0 else "attention")
    monkeypatch.setattr(terminal_user, "HELPER", "/nonexistent/hermes-tools-exec")
    assert sb.check_tools_user()["status"] == "attention"


def test_site_domains_from_conf_and_caddyfile(tmp_path):
    Path(sb.AQUARIUM_CONF).write_text("HOME_DOMAIN='home.example.com'\nDASHBOARD_DOMAIN=\n")
    Path(sb.CADDYFILE).write_text(
        "{\n  admin off\n}\nhome.example.com, https://dash.example.com:443 {\n  reverse_proxy 127.0.0.1:1\n"
        "  @x { path /a }\n}\n:8080 {\n}\nlocalhost {\n}\n")
    assert sb.site_domains(["Extra.Example.org", "bad domain"]) == [
        "extra.example.org", "home.example.com", "dash.example.com"]


# ------------------------------------------------------------------ real TLS


@pytest.fixture
def tls_server(tmp_path, monkeypatch):
    """A local TLS server with a cert for home.example.com signed by a test CA."""
    def ossl(*args):
        subprocess.run(["openssl", *args], check=True, capture_output=True, cwd=tmp_path)

    ossl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem",
         "-days", "30", "-subj", "/CN=Test CA")
    ossl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr",
         "-subj", "/CN=home.example.com")
    (tmp_path / "ext").write_text("subjectAltName=DNS:home.example.com\n")
    ossl("x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial",
         "-out", "leaf.pem", "-days", "90", "-extfile", "ext")
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(tmp_path / "leaf.pem", tmp_path / "leaf.key")
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sock.listen(5)
    stop = threading.Event()

    def serve():
        sock.settimeout(0.2)
        while not stop.is_set():
            try:
                conn, _ = sock.accept()
            except OSError:
                continue
            try:
                with ctx.wrap_socket(conn, server_side=True) as tls:
                    tls.recv(1)
            except (OSError, ssl.SSLError):
                pass

    thread = threading.Thread(target=serve, daemon=True)
    thread.start()
    monkeypatch.setattr(sb, "TLS_PORT", sock.getsockname()[1])
    monkeypatch.setattr(sb, "_tls_context", lambda: ssl.create_default_context(cafile=str(tmp_path / "ca.pem")))
    yield
    stop.set()
    thread.join(2)
    sock.close()


def test_tls_valid_certificate_reports_days_left(tls_server):
    check = sb.check_tls(["home.example.com"])
    cert = check["facts"]["certificates"][0]
    assert check["status"] == "ok" and cert["ok"] and 85 <= cert["days_left"] <= 90
    assert len(cert["valid_until"]) == 10


def test_tls_wrong_name_is_invalid_and_soon_expiry_needs_attention(tls_server, monkeypatch):
    check = sb.check_tls(["other.example.com"])
    assert check["status"] == "attention" and check["facts"]["certificates"][0]["error"] == "invalid"
    monkeypatch.setattr(sb, "TLS_WARN_DAYS", 120)
    assert sb.check_tls(["home.example.com"])["status"] == "attention"


def test_tls_nothing_listening_is_unreachable(monkeypatch):
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    monkeypatch.setattr(sb, "TLS_PORT", port)
    assert sb.check_tls(["home.example.com"])["facts"]["certificates"][0]["error"] == "unreachable"


# ------------------------------------------------------------------ API


@pytest.fixture
def acting(monkeypatch):
    from hermes_cli import web_server

    state = {"as": OWNER}

    async def _fake_principal(request, *, allow_as=False):
        return state["as"] or OWNER

    monkeypatch.setattr(web_server, "_comms_resolve_principal", _fake_principal)
    monkeypatch.setattr(web_server, "_comms_session_subject",
                        lambda request: state["as"].user_id if state["as"] else "")
    return state


@pytest.fixture
def client(acting):
    from starlette.testclient import TestClient

    from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN, app

    c = TestClient(app, raise_server_exceptions=False)
    c.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return c


@pytest.mark.parametrize("who", [MEMBER, VIEWER], ids=["member", "viewer"])
def test_member_and_viewer_cannot_read_or_run(client, acting, who, monkeypatch):
    monkeypatch.setattr(sb, "collect", lambda: pytest.fail("checks ran for a member"))
    acting["as"] = who
    assert client.get("/api/security-basics").status_code == 403
    assert client.post("/api/security-basics/test").status_code == 403


@pytest.mark.parametrize("who", [OWNER, ADMIN, None], ids=["owner", "admin", "operator"])
def test_owner_admin_run_and_read_back(client, acting, who):
    from hermes_constants import get_hermes_home

    acting["as"] = who
    before = client.get("/api/security-basics")
    assert before.status_code == 200 and before.json()["status"] == "not_started"
    assert before.json()["checked_at"] is None
    ran = client.post("/api/security-basics/test")
    assert ran.status_code == 200, ran.text
    body = ran.json()
    assert [c["id"] for c in body["checks"]] == list(sb.CHECK_IDS) and body["checked_at"]
    state = get_hermes_home() / sb.STATE_NAME
    assert stat.S_IMODE(state.stat().st_mode) == 0o600
    again = client.get("/api/security-basics").json()
    assert again["checked_at"] == body["checked_at"] and again["checks"] == body["checks"]


def test_second_test_while_running_is_409(client):
    assert sb._lock.acquire(blocking=False)
    try:
        assert client.post("/api/security-basics/test").status_code == 409
        assert client.get("/api/security-basics").json()["running"] is True
    finally:
        sb._lock.release()
