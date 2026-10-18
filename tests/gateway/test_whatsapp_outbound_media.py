"""WhatsApp attachments go through the bridge's media folder (security review F8).

The bridge's /send-media only reads files inside the folder it reports as
``outboundMediaDir``. These tests run a small local HTTP server standing in
for the bridge (no WhatsApp account, nothing sent) and check that the
adapter and the cron sender copy each file into that folder, send that
copy, and delete it afterwards.
"""

import asyncio
import os

import aiohttp
from aiohttp import web

from gateway.config import PlatformConfig
from plugins.platforms.whatsapp.adapter import WhatsAppAdapter, _standalone_send
from plugins.platforms.whatsapp.outbound_media import staged_for_bridge


async def _fake_bridge(media_dir):
    sent = []

    async def health(_request):
        body = {"status": "connected"}
        if media_dir is not None:
            body["outboundMediaDir"] = str(media_dir)
        return web.json_response(body)

    async def send(request):
        return web.json_response({"success": True, "messageId": "t1"})

    async def send_media(request):
        body = await request.json()
        path = body["filePath"]
        with open(path, "rb") as fh:
            body["bytes"] = fh.read()
        body["in_media_dir"] = media_dir is not None and os.path.dirname(path) == str(media_dir)
        sent.append(body)
        return web.json_response({"success": True, "messageId": f"m{len(sent)}"})

    app = web.Application()
    app.router.add_get("/health", health)
    app.router.add_post("/send", send)
    app.router.add_post("/send-media", send_media)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    return runner, port, sent


def test_adapter_stages_document_in_bridge_folder(tmp_path):
    media_dir = tmp_path / "whatsapp" / "outbound-media"
    report = tmp_path / "workspace" / "Q3 report.pdf"
    report.parent.mkdir()
    report.write_bytes(b"%PDF-1.4 hello")

    async def run():
        runner, port, sent = await _fake_bridge(media_dir)
        adapter = WhatsAppAdapter(PlatformConfig(enabled=True, extra={"session_name": "test"}))
        adapter._bridge_port = port
        adapter._running = True
        adapter._http_session = aiohttp.ClientSession()
        try:
            result = await adapter.send_document("123@s.whatsapp.net", str(report))
        finally:
            await adapter._http_session.close()
            await runner.cleanup()
        return result, sent

    result, sent = asyncio.run(run())
    assert result.success, result.error
    assert len(sent) == 1
    assert sent[0]["in_media_dir"] is True
    assert sent[0]["bytes"] == b"%PDF-1.4 hello"
    assert sent[0]["fileName"] == "Q3 report.pdf"
    assert sent[0]["filePath"].endswith(".pdf")
    assert os.listdir(media_dir) == []
    assert report.exists()


def test_cron_sender_stages_media_in_bridge_folder(tmp_path):
    media_dir = tmp_path / "outbound-media"
    img = tmp_path / "chart.png"
    img.write_bytes(b"PNG")
    voice = tmp_path / "note.ogg"
    voice.write_bytes(b"OggS")

    async def run():
        runner, port, sent = await _fake_bridge(media_dir)
        try:
            res = await _standalone_send(
                PlatformConfig(enabled=True, extra={"bridge_port": port}),
                "12345",
                "hi",
                media_files=[(str(img), False), (str(voice), True)],
            )
        finally:
            await runner.cleanup()
        return res, sent

    res, sent = asyncio.run(run())
    assert res.get("success") is True, res
    assert [s["mediaType"] for s in sent] == ["image", "audio"]
    assert all(s["in_media_dir"] for s in sent)
    assert [s["bytes"] for s in sent] == [b"PNG", b"OggS"]
    assert os.listdir(media_dir) == []


def test_old_bridge_without_media_folder_gets_original_path(tmp_path):
    img = tmp_path / "chart.png"
    img.write_bytes(b"PNG")

    async def run():
        runner, port, sent = await _fake_bridge(None)
        try:
            res = await _standalone_send(
                PlatformConfig(enabled=True, extra={"bridge_port": port}),
                "12345",
                "",
                media_files=[(str(img), False)],
            )
        finally:
            await runner.cleanup()
        return res, sent

    res, sent = asyncio.run(run())
    assert res.get("success") is True, res
    assert sent[0]["filePath"] == str(img)


def test_staged_name_never_carries_the_original_name(tmp_path):
    src = tmp_path / "x$(touch PWNED)`id`.mp3"
    src.write_bytes(b"mp3")
    weird = tmp_path / "noext.$(id)"
    weird.write_bytes(b"?")
    media_dir = tmp_path / "out"
    with staged_for_bridge(str(src), str(media_dir)) as staged:
        name = os.path.basename(staged)
        assert name.startswith("out_") and name.endswith(".mp3")
        assert "$" not in name and "`" not in name
    with staged_for_bridge(str(weird), str(media_dir)) as staged:
        assert "." not in os.path.basename(staged)
    assert os.listdir(media_dir) == []
