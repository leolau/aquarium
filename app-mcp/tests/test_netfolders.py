"""Network folders (``net-*``) served server-side by the folder_bridge_*
tools: shapes match the browser's, traversal/symlinks refused, import gated
and delegated to Hermes, mixed browser+network search, works with no
browser connected. Hermes is faked with an httpx MockTransport."""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

import httpx
import pytest

from app_mcp import netfolders as nf
from app_mcp import server

TOKEN = "x" * 40


class FakeHermes:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.requests: list[tuple[str, str, dict]] = []
        self.folders = [
            {"id": "net-tenders", "name": "Tender documents", "vpn": "Office files",
             "trusted_for_import": False, "mounted": False,
             "mount_path": str(root / "net-tenders"), "status": {"error": None}},
        ]
        self.mount_error: str | None = None

    def handler(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content or b"{}")
        self.requests.append((request.method, request.url.path, body))
        if request.headers.get("authorization") != f"Bearer {TOKEN}":
            return httpx.Response(401, json={"detail": "Unauthorized"})
        if request.url.path == "/api/internal/vpn/folders":
            return httpx.Response(200, json={"folders": self.folders})
        if request.url.path == "/api/internal/vpn/folders/ensure":
            folder = next((f for f in self.folders if f["id"] == body["id"]), None)
            if folder is None:
                return httpx.Response(404, json={"detail": "unknown network folder id"})
            if self.mount_error:
                return httpx.Response(200, json={"folder": {**folder, "mounted": False,
                                                            "status": {"error": self.mount_error}}})
            folder["mounted"] = True
            (self.root / folder["id"]).mkdir(exist_ok=True)
            return httpx.Response(200, json={"folder": folder})
        if request.url.path == "/api/internal/vpn/folders/import":
            return httpx.Response(200, json={"ok": True, "folderId": body["id"], "path": body["path"],
                                             "assetId": "a1", "filename": "x", "size": 1,
                                             "sha256": "0" * 64, "storageBucket": "b",
                                             "storagePath": "p", "verified": True})
        return httpx.Response(404, json={})


@pytest.fixture
def world(tmp_path, monkeypatch):
    root = tmp_path / "vpn-files"
    root.mkdir()
    fake = FakeHermes(root)
    monkeypatch.setenv("APP_MCP_NET_FOLDER_ROOT", str(root))
    client = nf.HermesClient(base_url="http://hermes", token=TOKEN,
                             transport=httpx.MockTransport(fake.handler))
    monkeypatch.setattr(server, "hermes", client)
    # "mounted" == Hermes said so (no real mounts in tests)
    monkeypatch.setattr(nf, "is_mounted", lambda p, proc_mounts="": any(
        f["mounted"] and Path(f["mount_path"]) == Path(p) for f in fake.folders))
    monkeypatch.setattr(nf.ensure_root, "__kwdefaults__", {"mounted": nf.is_mounted})
    folder = root / "net-tenders"
    folder.mkdir()
    (folder / "2026").mkdir()
    (folder / "2026" / "Bid notes.md").write_text("# Bid\nprice 42\n")
    (folder / "2026" / "Bid.pdf").write_bytes(b"%PDF-1.7\xff\xfe binary")
    (folder / "readme.txt").write_text("hello")
    (tmp_path / "outside.txt").write_text("secret")
    os.symlink(tmp_path / "outside.txt", folder / "link.txt")
    os.symlink(tmp_path, folder / "dirlink")
    fake.folder = folder
    return fake


def run(coro):
    return asyncio.run(coro)


def test_list_folders_without_browser(world):
    assert not server.folder_hub.connected
    out = run(server.folder_bridge_list_folders())
    assert out["ok"] is True and "browser" in out
    assert out["folders"] == [{"id": "net-tenders", "label": "Tender documents",
                               "permission": "granted", "trusted": False, "kind": "network",
                               "vpn": "Office files", "mounted": False}]


def test_list_folders_unconfigured_keeps_old_hint(monkeypatch):
    monkeypatch.setattr(server, "hermes", nf.HermesClient(token=""))
    out = run(server.folder_bridge_list_folders())
    assert out == {"ok": False, "detail": server.NOT_CONNECTED_HINT}


def test_state_counts_network_folders(world):
    out = run(server.folder_bridge_state())
    assert out["connected"] is False and out["network_folders"] == 1
    assert out["network_folders_mounted"] == 0


def test_list_directory_mounts_then_lists(world):
    out = run(server.folder_bridge_list_directory("net-tenders"))
    assert out["ok"] is True
    names = [(e["name"], e["kind"]) for e in out["entries"]]
    assert names == [("2026", "directory"), ("readme.txt", "file")]  # symlinks hidden
    readme = out["entries"][1]
    assert readme["path"] == "readme.txt" and readme["size"] == 5
    assert readme["modifiedAt"].endswith("Z") and "." in readme["modifiedAt"]
    assert [r[1] for r in world.requests].count("/api/internal/vpn/folders/ensure") == 1
    sub = run(server.folder_bridge_list_directory("net-tenders", "2026"))
    assert [e["path"] for e in sub["entries"]] == ["2026/Bid notes.md", "2026/Bid.pdf"]
    # already mounted: no second ensure
    assert [r[1] for r in world.requests].count("/api/internal/vpn/folders/ensure") == 1


def test_mount_failure_is_reported(world):
    world.mount_error = "File share login failed: check the file share username and password"
    out = run(server.folder_bridge_list_directory("net-tenders"))
    assert out == {"ok": False, "detail": world.mount_error}


@pytest.mark.parametrize("path", ["../outside.txt", "2026/../../outside.txt", "link.txt",
                                  "dirlink/outside.txt", "/../x"])
def test_traversal_and_symlinks_refused(world, path):
    for result in (
        run(server.folder_bridge_read_file("net-tenders", path)),
        run(server.folder_bridge_get_file_metadata("net-tenders", path)),
    ):
        assert result["ok"] is False, (path, result)
        assert "secret" not in json.dumps(result)
    assert run(server.folder_bridge_list_directory("net-tenders", "dirlink"))["ok"] is False


def test_unknown_net_id(world):
    assert run(server.folder_bridge_list_directory("net-../../etc"))["ok"] is False
    out = run(server.folder_bridge_list_directory("net-nope"))
    assert out["ok"] is False and "unknown" in out["detail"].lower()


def test_read_file_shapes(world):
    out = run(server.folder_bridge_read_file("net-tenders", "2026/Bid notes.md"))
    assert out == {"ok": True, "folderId": "net-tenders", "path": "2026/Bid notes.md",
                   "encoding": "utf-8", "size": 15, "content": "# Bid\nprice 42\n",
                   "truncated": False}
    out = run(server.folder_bridge_read_file("net-tenders", "2026/Bid notes.md", max_bytes=8))
    assert out["truncated"] is True and out["content"] == "# Bi"
    out = run(server.folder_bridge_read_file("net-tenders", "2026/Bid.pdf"))
    assert out["binary"] is True and out["content"] == "" and out["truncated"] is False
    out = run(server.folder_bridge_read_file("net-tenders", "2026"))
    assert out["ok"] is False and "Not a file" in out["detail"]


def test_metadata_shape(world):
    out = run(server.folder_bridge_get_file_metadata("net-tenders", "readme.txt"))
    assert set(out) == {"ok", "folderId", "path", "size", "modifiedAt"} and out["size"] == 5


def test_search_network_folder(world):
    out = run(server.folder_bridge_search_files(["net-tenders"], "bid"))
    assert out["ok"] is True
    assert [m["path"] for m in out["matches"]] == ["2026/Bid notes.md", "2026/Bid.pdf"]
    md = out["matches"][0]
    assert md["folderLabel"] == "Tender documents" and md["snippet"].startswith("# Bid")
    assert "snippet" not in out["matches"][1]
    out = run(server.folder_bridge_search_files(["net-tenders"], "*.pdf"))
    assert [m["path"] for m in out["matches"]] == ["2026/Bid.pdf"]
    out = run(server.folder_bridge_search_files(["net-tenders"], "2026", extensions=[".md"]))
    assert [m["path"] for m in out["matches"]] == ["2026/Bid notes.md"]
    out = run(server.folder_bridge_search_files(["net-tenders"], "Tender documents/2026/*.pdf"))
    assert [m["path"] for m in out["matches"]] == ["2026/Bid.pdf"]
    out = run(server.folder_bridge_search_files(["net-tenders"], "", limit=1))
    assert len(out["matches"]) == 1


def test_mixed_search_without_browser_returns_network_matches(world):
    out = run(server.folder_bridge_search_files(["local-1", "net-tenders"], "readme"))
    assert out["ok"] is True and [m["path"] for m in out["matches"]] == ["readme.txt"]
    assert out["warnings"] == [server.NOT_CONNECTED_HINT]


def test_mixed_search_with_browser(world, monkeypatch):
    # The request is for alice (Hermes forwards the chat's user in _meta).
    monkeypatch.setattr(server, "_caller", lambda: "alice")

    class Conn:
        async def send(self, message: str) -> None:
            msg = json.loads(message)
            assert msg["command"]["folderIds"] == ["local-1"]
            server.folder_hub.resolve_result(self, msg["id"], {
                "ok": True, "matches": [{"folderId": "local-1", "folderLabel": "Mac",
                                         "path": "readme.md", "size": 1,
                                         "modifiedAt": "2026-01-01T00:00:00.000Z"}]})

    async def scenario():
        conn = Conn()
        server.folder_hub.attach(conn, "alice")
        try:
            return await server.folder_bridge_search_files(["local-1", "net-tenders"], "readme")
        finally:
            server.folder_hub.detach(conn)

    out = run(scenario())
    assert [(m["folderId"], m["path"]) for m in out["matches"]] == [
        ("local-1", "readme.md"), ("net-tenders", "readme.txt")]


def test_browser_only_search_is_unchanged(world):
    out = run(server.folder_bridge_search_files(["local-1"], "x"))
    assert out == {"ok": False, "detail": server.NOT_CONNECTED_HINT}


def test_import_goes_to_hermes_with_approval_flag(world):
    out = run(server.folder_bridge_import_file("net-tenders", "2026/Bid.pdf"))
    assert out["ok"] is True and out["verified"] is True
    out = run(server.folder_bridge_import_file_approved("net-tenders", "2026/Bid.pdf"))
    imports = [r[2] for r in world.requests if r[1].endswith("/import")]
    assert imports == [
        {"id": "net-tenders", "path": "2026/Bid.pdf", "approved": False},
        {"id": "net-tenders", "path": "2026/Bid.pdf", "approved": True},
    ]


def test_bad_token_is_a_readable_error(world, monkeypatch):
    monkeypatch.setattr(server.hermes, "token", "wrong")
    out = run(server.folder_bridge_list_directory("net-tenders"))
    assert out == {"ok": False, "detail": "Unauthorized"}
    out = run(server.folder_bridge_list_folders())
    assert out["network_error"] == "Unauthorized"


def test_name_matcher_glob_and_substring():
    assert nf.name_matcher("*.PDF")("bid.pdf")
    assert not nf.name_matcher("inv-??.xlsx")("inv-123.xlsx")
    assert nf.name_matcher("ender")("Tender")
