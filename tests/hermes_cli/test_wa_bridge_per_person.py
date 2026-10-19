"""WhatsApp bridges are per person (Get ready item 5).

Real files under a temp HERMES_HOME (session dirs, creds.json, qr.txt,
bridge-owners.json) and a fake bridge HTTP server for "Send yourself a test";
only systemctl/sudo are stubbed. No real WhatsApp message is ever sent.
"""

from __future__ import annotations

import asyncio
import json
import os
import stat
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import hermes_cli.wa_bridge_api as api
from hermes_cli import wa_bridge_owners as owners

LEO = SimpleNamespace(user_id="leo", display="Leo", role="owner", is_owner=True)
BEN = SimpleNamespace(user_id="ben", display="Ben", role="admin", is_owner=False)
AMY = SimpleNamespace(user_id="amy", display="Amy", role="member", is_owner=False)
TOM = SimpleNamespace(user_id="tom", display="Tom", role="viewer", is_owner=False)


class _Req:
    def __init__(self, body=None):
        self._body = body or {}

    async def json(self):
        return self._body


class _Proc:
    def __init__(self, stdout="", returncode=0, stderr=""):
        self.stdout, self.stderr, self.returncode = stdout, stderr, returncode


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.delenv("WHATSAPP_BRIDGES", raising=False)
    wa = tmp_path / "whatsapp"
    wa.mkdir()
    monkeypatch.setattr(api, "_is_active", lambda n: "active")
    monkeypatch.setattr(api, "_systemctl", lambda *a, **k: _Proc())
    monkeypatch.setattr(api, "_service_control", lambda n, v: None)

    async def _owner_id():
        return "leo"

    async def _displays(ids):
        return {"leo": "Leo", "amy": "Amy Chan", "ben": "Ben"}

    monkeypatch.setattr(api, "_owner_user_id", _owner_id)
    monkeypatch.setattr(api, "_displays", _displays)
    return wa


def _as(monkeypatch, who):
    async def _caller(_request):
        return who

    monkeypatch.setattr(api, "_caller", _caller)


def _session(wa, name, *, number="85291234567", qr=False):
    d = wa / f"session-{name}"
    d.mkdir()
    if number:
        (d / "creds.json").write_text(json.dumps({"me": {"id": f"{number}:7@s.whatsapp.net"}}))
    if qr:
        (d / "qr.txt").write_text("2@secret-pairing-payload")
    return d


def run(coro):
    return asyncio.run(coro)


def test_unrecorded_bridge_stays_the_install_owners(home, monkeypatch):
    """Existing box: personal/connectar have no person recorded → still Leo's."""
    _session(home, "personal")
    _session(home, "connectar", qr=True)
    _as(monkeypatch, LEO)
    out = run(api.list_bridges(_Req()))
    assert {b["name"] for b in out["bridges"]} == {"personal", "connectar"}
    assert out["others"] == []
    assert run(api.get_qr(_Req(), "connectar"))["payload"] == "2@secret-pairing-payload"

    for who in (AMY, BEN, TOM):
        _as(monkeypatch, who)
        listed = run(api.list_bridges(_Req()))
        assert listed["bridges"] == []
        with pytest.raises(HTTPException) as exc:
            run(api.get_qr(_Req(), "connectar"))
        assert exc.value.status_code == 403


def test_each_person_sees_and_controls_only_their_own(home, monkeypatch):
    _session(home, "personal")
    _session(home, "amy", number="85298765432", qr=True)
    owners.record_owner("amy", "amy", port=3002)

    _as(monkeypatch, AMY)
    out = run(api.list_bridges(_Req()))
    assert [b["name"] for b in out["bridges"]] == ["amy"]
    assert out["bridges"][0]["status"] == "waiting_for_qr"
    assert out["others"] == []
    assert run(api.get_qr(_Req(), "amy"))["payload"]
    for action in (api.restart_bridge, api.stop_bridge, api.rebind_bridge):
        with pytest.raises(HTTPException) as exc:
            run(action(_Req(), "personal"))
        assert exc.value.status_code == 403

    # The owner (and an admin) cannot see Amy's QR or control her bridge.
    for who in (LEO, BEN):
        _as(monkeypatch, who)
        for call in (api.get_qr, api.restart_bridge, api.stop_bridge,
                     api.rebind_bridge, api.send_test):
            with pytest.raises(HTTPException) as exc:
                run(call(_Req(), "amy"))
            assert exc.value.status_code == 403, (who.user_id, call.__name__)
    assert (home / "session-amy" / "qr.txt").is_file()  # rebind never ran


def test_owner_and_admin_get_only_a_status_for_other_people(home, monkeypatch):
    _session(home, "personal")
    _session(home, "amy", number="85298765432", qr=True)
    owners.record_owner("amy", "amy")

    _as(monkeypatch, BEN)
    out = run(api.list_bridges(_Req()))
    assert out["bridges"] == []
    by_name = {o["name"]: o for o in out["others"]}
    assert by_name["amy"] == {
        "name": "amy", "person": "amy", "person_display": "Amy Chan",
        "status": "waiting_for_qr",
    }
    assert by_name["personal"]["person"] == "leo"
    assert "2@secret" not in json.dumps(out)
    assert "9876" not in json.dumps(out)

    _as(monkeypatch, LEO)
    out = run(api.list_bridges(_Req()))
    assert [b["name"] for b in out["bridges"]] == ["personal"]
    assert [o["name"] for o in out["others"]] == ["amy"]

    # Members and viewers see nobody else's bridges.
    _as(monkeypatch, TOM)
    assert run(api.list_bridges(_Req()))["others"] == []


def test_adding_a_bridge_records_its_person_and_port(home, monkeypatch):
    _as(monkeypatch, AMY)
    calls = []
    monkeypatch.setattr(api, "_add_helper_installed", lambda: True)

    def fake_run(cmd, **kw):
        calls.append(cmd)
        return _Proc(stdout="provisioned hermes-wa-bridge-amy.service on port 3004 (session x)")

    monkeypatch.setattr(api.subprocess, "run", fake_run)
    out = run(api.add_bridge(_Req({"name": "amy"})))
    assert calls == [["sudo", "-n", "/usr/local/sbin/hermes-wa-bridge-add", "amy"]]
    assert out["bridge"]["name"] == "amy"
    assert owners.bridge_person("amy") == "amy"
    assert owners.recorded_port("amy") == 3004
    mode = stat.S_IMODE(os.stat(home / owners.OWNERS_FILE).st_mode)
    assert mode == 0o600


def test_single_user_install_operator_is_the_owner(home, monkeypatch):
    from hermes_cli import web_server as ws

    async def _not_configured(request, allow_as=False):
        raise ws._CommsNotConfigured("no dsn")

    monkeypatch.setattr(ws, "_comms_resolve_principal", _not_configured)
    _session(home, "personal")
    out = run(api.list_bridges(_Req()))
    assert [b["name"] for b in out["bridges"]] == ["personal"]


class _FakeBridge(BaseHTTPRequestHandler):
    sent: list = []
    status = 200

    def do_POST(self):  # noqa: N802 - http.server API
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        type(self).sent.append((self.path, body))
        self.send_response(self.status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        if self.status == 200:
            self.wfile.write(b'{"success": true, "messageId": "M1"}')
        else:
            self.wfile.write(b'{"error": "Not connected to WhatsApp"}')

    def log_message(self, *args):
        pass


@pytest.fixture
def fake_bridge():
    _FakeBridge.sent = []
    _FakeBridge.status = 200
    server = HTTPServer(("127.0.0.1", 0), _FakeBridge)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield server
    server.shutdown()


def test_send_test_goes_only_to_the_bridges_own_number(home, monkeypatch, fake_bridge):
    _session(home, "amy", number="85298765432")
    owners.record_owner("amy", "amy", port=fake_bridge.server_port)
    _as(monkeypatch, AMY)
    out = run(api.send_test(_Req({"to": "+85211112222"}), "amy"))
    assert out == {"sent": True, "to": "+852****5432"}
    assert len(_FakeBridge.sent) == 1
    path, body = _FakeBridge.sent[0]
    assert path == "/send"
    assert body["chatId"] == "85298765432@s.whatsapp.net"
    assert body["message"] == api.TEST_MESSAGE


def test_send_test_port_from_unit_file_for_old_bridges(home, monkeypatch, fake_bridge):
    _session(home, "personal", number="85290000001")
    port = fake_bridge.server_port
    monkeypatch.setattr(
        api, "_systemctl",
        lambda *a, **k: _Proc(stdout=f"ExecStart=/usr/bin/node bridge.js --port {port} --session x\n"),
    )
    _as(monkeypatch, LEO)
    assert run(api.send_test(_Req(), "personal"))["sent"] is True
    assert _FakeBridge.sent[0][1]["chatId"] == "85290000001@s.whatsapp.net"


def test_send_test_needs_a_linked_phone(home, monkeypatch, fake_bridge):
    _session(home, "amy", number=None, qr=True)
    owners.record_owner("amy", "amy", port=fake_bridge.server_port)
    _as(monkeypatch, AMY)
    with pytest.raises(HTTPException) as exc:
        run(api.send_test(_Req(), "amy"))
    assert exc.value.status_code == 409
    assert _FakeBridge.sent == []


def test_send_test_reports_a_disconnected_bridge(home, monkeypatch, fake_bridge):
    _session(home, "amy", number="85298765432")
    owners.record_owner("amy", "amy", port=fake_bridge.server_port)
    _FakeBridge.status = 503
    _as(monkeypatch, AMY)
    with pytest.raises(HTTPException) as exc:
        run(api.send_test(_Req(), "amy"))
    assert exc.value.status_code == 409


def test_owner_file_helpers(home):
    assert owners.bridge_person("x") is None
    (home / owners.OWNERS_FILE).write_text("not json")
    assert owners.load_owners() == {}
    assert owners.bridge_name_for_session_path(home / "session-amy") == "amy"
    assert owners.bridge_name_for_session_path("/x/platforms/whatsapp/session") is None
    assert owners.mask_number("85298765432") == "+852****5432"
