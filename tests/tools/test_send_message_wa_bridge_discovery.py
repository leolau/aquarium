"""send_message reaches every WhatsApp bridge installed on the box, not only
the ones listed in ``WHATSAPP_BRIDGES``, and delivers an attachment by staging
it into the bridge's own outbound-media folder."""

from __future__ import annotations

import asyncio
import json
import os
import socket
import threading

import pytest
web = pytest.importorskip("aiohttp.web")

from hermes_cli import wa_bridge_owners as owners
import tools.send_message_tool as smt


def _unit(port: int, name: str) -> str:
    return (
        "[Service]\nUser=hermes\n"
        f"ExecStart=/usr/bin/node bridge.js --port {port} --session /x/whatsapp/session-{name}\n"
    )


@pytest.fixture
def box(tmp_path, monkeypatch):
    home = tmp_path / "home"
    units = tmp_path / "systemd"
    envs = tmp_path / "aquarium"
    for d in (home, units, envs):
        d.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.delenv("WHATSAPP_BRIDGES", raising=False)
    monkeypatch.delenv("WHATSAPP_BRIDGE_PORT", raising=False)
    monkeypatch.setattr(owners, "UNIT_DIR", units)
    monkeypatch.setattr(owners, "UNIT_ENV_DIR", envs)
    return home, units, envs


def test_installed_units_and_settings_bridges_are_known(box, monkeypatch):
    _home, units, envs = box
    (units / "hermes-wa-bridge-personal.service").write_text(_unit(3000, "personal"))
    (units / "hermes-wa-bridge-connectar.service").write_text(_unit(3001, "connectar"))
    (units / "hermes-wa-bridge-personal.service.d").mkdir()
    (envs / "wa-bridge-amy.env").write_text("WA_BRIDGE_PORT=3002\n")
    owners.record_owner("ben", "ben", port=3003)
    assert owners.bridge_ports() == {
        "ben": 3003, "connectar": 3001, "personal": 3000, "amy": 3002,
    }


def test_whatsapp_bridges_env_stays_first_and_wins(box, monkeypatch):
    _home, units, _envs = box
    (units / "hermes-wa-bridge-connectar.service").write_text(_unit(3001, "connectar"))
    (units / "hermes-wa-bridge-personal.service").write_text(_unit(3999, "personal"))
    monkeypatch.setenv("WHATSAPP_BRIDGES", "personal:3000")
    ports = owners.bridge_ports()
    assert list(ports) == ["personal", "connectar"]
    assert ports["personal"] == 3000


def test_unit_without_port_or_bad_name_is_skipped(box):
    _home, units, _envs = box
    (units / "hermes-wa-bridge-nope.service").write_text("[Service]\nExecStart=/usr/bin/node bridge.js\n")
    (units / "hermes-wa-bridge-Bad_Name.service").write_text(_unit(3005, "x"))
    assert owners.bridge_ports() == {}


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class _FakeBridge:
    """A real HTTP bridge stand-in that, like bridge.js, only accepts files
    that sit inside its outbound-media folder at the time of the call."""

    def __init__(self, media_dir: str, port: int):
        self.media_dir = os.path.realpath(media_dir)
        self.port = port
        self.sent = []
        self._loop = asyncio.new_event_loop()
        self._ready = threading.Event()

    async def _health(self, _req):
        return web.json_response({"status": "connected", "outboundMediaDir": self.media_dir})

    async def _send_media(self, req):
        body = await req.json()
        real = os.path.realpath(body["filePath"])
        if os.path.dirname(real) != self.media_dir or not os.path.isfile(real):
            return web.json_response({"error": "outside outbound-media"}, status=403)
        with open(real, "rb") as fh:
            self.sent.append((body, fh.read()))
        return web.json_response({"success": True, "messageId": "M1"})

    async def _send(self, req):
        self.sent.append((await req.json(), None))
        return web.json_response({"success": True, "messageId": "T1"})

    def __enter__(self):
        app = web.Application()
        app.router.add_get("/health", self._health)
        app.router.add_post("/send-media", self._send_media)
        app.router.add_post("/send", self._send)

        def run():
            asyncio.set_event_loop(self._loop)
            self._runner = web.AppRunner(app)
            self._loop.run_until_complete(self._runner.setup())
            site = web.TCPSite(self._runner, "127.0.0.1", self.port)
            self._loop.run_until_complete(site.start())
            self._ready.set()
            self._loop.run_forever()

        self._thread = threading.Thread(target=run, daemon=True)
        self._thread.start()
        assert self._ready.wait(10)
        return self

    def __exit__(self, *exc):
        fut = asyncio.run_coroutine_threadsafe(self._runner.cleanup(), self._loop)
        fut.result(10)
        self._loop.call_soon_threadsafe(self._loop.stop)
        self._thread.join(10)


def test_named_installed_bridge_sends_attachment_staged_in_its_folder(box, monkeypatch):
    home, units, _envs = box
    personal_port, connectar_port = _free_port(), _free_port()
    (units / "hermes-wa-bridge-personal.service").write_text(_unit(personal_port, "personal"))
    (units / "hermes-wa-bridge-connectar.service").write_text(_unit(connectar_port, "connectar"))
    monkeypatch.setenv("WHATSAPP_BRIDGES", f"personal:{personal_port}")

    workspace = home / "workspaces" / "quote"
    workspace.mkdir(parents=True)
    pdf = workspace / "quotation_v1.2.pdf"
    pdf.write_bytes(b"%PDF-1.4 quote")
    media_dir = home / "whatsapp" / "outbound-media"
    media_dir.mkdir(parents=True)
    monkeypatch.setenv("HERMES_MEDIA_ALLOW_DIRS", str(workspace))

    with _FakeBridge(str(media_dir), connectar_port) as bridge:
        out = json.loads(smt.send_message_tool({
            "action": "send",
            "target": "whatsapp:connectar:192912952401976@lid",
            "message": f"Attached the quotation.\nMEDIA:{pdf}",
        }))

    assert out.get("success") is True, out
    media_calls = [(b, data) for b, data in bridge.sent if data is not None]
    assert len(media_calls) == 1
    body, data = media_calls[0]
    assert body["chatId"] == "192912952401976@lid"
    assert data == b"%PDF-1.4 quote"
    assert os.path.dirname(os.path.realpath(body["filePath"])) == bridge.media_dir
    assert os.listdir(media_dir) == []
