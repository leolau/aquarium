"""Files → Browse: one-level, symlink-refusing listings and scoped places."""

from __future__ import annotations

import asyncio
import os
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from hermes_cli import browse_api, vpn


@pytest.fixture()
def share(tmp_path):
    root = tmp_path / "share"
    (root / "Offers" / "2026").mkdir(parents=True)
    (root / "Offers" / "2026" / "deep.pdf").write_bytes(b"x" * 5)
    (root / "Offers" / "quote.pdf").write_bytes(b"abc")
    (root / "b.txt").write_text("hi")
    (root / "A-folder").mkdir()
    outside = tmp_path / "secret.env"
    outside.write_text("KEY=1")
    os.symlink(outside, root / "link.env")
    os.symlink(tmp_path, root / "up")
    return root


def test_lists_one_level_folders_first(share):
    out = browse_api.list_dir(str(share), "")
    assert [e["name"] for e in out["entries"]] == ["A-folder", "Offers", "b.txt"]
    assert out["entries"][2]["size"] == 2 and out["entries"][2]["path"] == "b.txt"
    assert out["truncated"] is False


def test_subfolder_paths_are_relative_to_the_place(share):
    out = browse_api.list_dir(str(share), "Offers")
    assert [(e["path"], e["kind"]) for e in out["entries"]] == [
        ("Offers/2026", "directory"), ("Offers/quote.pdf", "file")]


def test_symlinks_are_hidden_and_cannot_be_entered(share):
    names = [e["name"] for e in browse_api.list_dir(str(share), "")["entries"]]
    assert "link.env" not in names and "up" not in names
    with pytest.raises(vpn.VpnError):
        browse_api.list_dir(str(share), "up")


@pytest.mark.parametrize("bad", ["..", "Offers/../..", "a\x00b"])
def test_traversal_is_refused(share, bad):
    with pytest.raises(vpn.VpnError):
        browse_api.list_dir(str(share), bad)


def test_listing_is_capped(share, monkeypatch):
    monkeypatch.setattr(browse_api, "MAX_ENTRIES", 2)
    out = browse_api.list_dir(str(share), "")
    assert len(out["entries"]) == 2 and out["truncated"] is True


def test_workspace_is_the_callers_own_folder(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    mia = SimpleNamespace(user_id="mia")
    root, label = asyncio.run(browse_api.resolve_place(mia, "workspace"))
    assert root == str(tmp_path / "workspaces" / "mia") and label == "Workspace"


def test_unknown_or_other_peoples_folder_is_404(monkeypatch):
    async def none(principal):
        return []

    monkeypatch.setattr(browse_api.vpn_folders, "readable_folders", none)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(browse_api.resolve_place(SimpleNamespace(user_id="mia"), "net-jensen"))
    assert exc.value.status_code == 404


def test_places_lists_readable_folders_then_workspace(monkeypatch):
    own = SimpleNamespace(owner_user_id="mia", name="Mine")
    shared = SimpleNamespace(owner_user_id="root", name="Shared")

    async def readable(principal):
        return [own, shared]

    async def view_of(cred):
        return {"id": f"net-{cred.name.lower()}", "name": cred.name, "vpn": "office",
                "trusted_for_import": False,
                "status": {"mounted": True, "error": None}}

    monkeypatch.setattr(browse_api.vpn_folders, "readable_folders", readable)
    monkeypatch.setattr(browse_api.vpn_folders, "view_of", view_of)
    out = asyncio.run(browse_api.places(SimpleNamespace(user_id="mia")))
    assert [(p["id"], p.get("shared")) for p in out] == [
        ("net-mine", False), ("net-shared", True), ("workspace", None)]


def test_readable_folders_keeps_own_and_shared_only(monkeypatch):
    from hermes_cli import vpn_folders

    def cred(owner, visibility, kind=vpn_folders.KIND):
        return SimpleNamespace(owner_user_id=owner, visibility=visibility, kind=kind,
                               provider=vpn_folders.PROVIDER)

    mine, shared, private = cred("mia", "private"), cred("root", "shared"), cred("root", "private")
    vpn_cred = cred("mia", "private", kind="fortinet-vpn")

    class Store:
        async def list(self, principal):
            return [mine, shared, private, vpn_cred]

    monkeypatch.setattr(vpn_folders, "default_credential_store", lambda: Store())
    got = asyncio.run(vpn_folders.readable_folders(SimpleNamespace(user_id="mia")))
    assert got == [mine, shared]
