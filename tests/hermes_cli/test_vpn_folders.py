"""Network folders (``smb-folder`` through a ``fortinet-vpn``): the kind,
``hermes_cli.vpn_folders``, the ``/api/vpn/folders`` routes (owner-only) and
the app-mcp internal routes behind the token-auth seam. The root helper is
faked at ``vpn.run_helper``; its real folder commands are covered in
``tests/deploy/test_hermes_vpn_helper.py``."""

from __future__ import annotations

import asyncio
import hashlib
import os
from pathlib import Path
from typing import Any, Dict, List

import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient

from hermes_cli import credentials_api, vpn, vpn_api, vpn_folders
from hermes_cli.access import Principal
from hermes_cli.credential_store import (
    CREDENTIAL_KINDS,
    CredentialError,
    FileCredentialStore,
    default_credential_store,
    materialize_for_mounts,
    redact_payload,
    validate_payload,
)
from hermes_cli.dashboard_auth.token_auth import token_auth_middleware

OWNER = Principal(user_id="owner", display="Owner", role="owner")
ALICE = Principal(user_id="alice", display="Alice", role="member")
BOB = Principal(user_id="bob", display="Bob", role="member")
VPN_PAYLOAD = {
    "host": "vpn.example.com",
    "username": "alice",
    "password": "s3cret-vpn",
    "routes": ["10.20.0.0/16"],
}
TOKEN = "t" * 20 + "0123456789abcdefghij"
VIEW_KEYS = {
    "id",
    "name",
    "vpn",
    "vpn_slug",
    "share_path",
    "share_username",
    "has_share_password",
    "share_domain",
    "trusted_for_import",
    "mount_path",
    "status",
}


def run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def file_store(tmp_path, monkeypatch):
    store = default_credential_store()
    assert isinstance(store, FileCredentialStore), "tests need the file backend"
    monkeypatch.setattr(vpn, "MOUNT_ROOT", str(tmp_path / "vpn-files"))
    return store


class FakeHelper:
    def __init__(self) -> None:
        self.calls: List[tuple] = []
        self.vpns: Dict[str, str] = {}
        self.folders: Dict[str, Dict[str, Any]] = {}
        self.up_state = "connected"
        self.up_error = None
        self.mount_error = None

    def __call__(self, command, slug, *, spec=None):
        self.calls.append((command, slug, spec))
        if command == "up":
            self.vpns[slug] = self.up_state
            return {"state": self.up_state, "error": self.up_error}
        if command == "down":
            self.vpns[slug] = "disconnected"
            for f in self.folders.values():
                if f["vpn_slug"] == slug:
                    f["mounted"] = False
            return {"state": "disconnected"}
        if command == "status":
            return {"state": self.vpns.get(slug, "disconnected")}
        if command == "mount":
            vslug = spec["vpn_slug"]
            if self.vpns.get(vslug) != "connected":
                self.folders[slug] = {
                    "vpn_slug": vslug,
                    "mounted": False,
                    "error": "VPN is not connected",
                }
            elif self.mount_error:
                self.folders[slug] = {
                    "vpn_slug": vslug,
                    "mounted": False,
                    "error": self.mount_error,
                }
            else:
                self.folders[slug] = {"vpn_slug": vslug, "mounted": True, "error": None}
                Path(vpn.MOUNT_ROOT, f"net-{slug}").mkdir(parents=True, exist_ok=True)
            return {"folder_slug": slug, **self.folders[slug]}
        if command == "umount":
            if slug in self.folders:
                self.folders[slug]["mounted"] = False
            return {"folder_slug": slug, "mounted": False}
        if command == "fstatus":
            return {
                "folder_slug": slug,
                **self.folders.get(slug, {"mounted": False, "error": None}),
            }
        if command == "fcheck":
            doc = {"folder_slug": slug, **self.folders.get(slug, {"mounted": False})}
            doc["check"] = {
                "at": "2026-10-17T03:50:00Z",
                "ok": True,
                "file_count": 7,
                "message": "File server reachable, 7 files listed.",
            }
            return doc
        raise AssertionError(command)

    def commands(self):
        return [c[0] for c in self.calls]

    def specs(self, command):
        return [c[2] for c in self.calls if c[0] == command]


@pytest.fixture
def helper(monkeypatch):
    fake = FakeHelper()
    monkeypatch.setattr(vpn, "run_helper", fake)
    return fake


def put_vpn(store, principal, name="Office files", payload=None, visibility=None):
    return run(
        store.put(
            principal,
            provider="fortinet",
            name=name,
            kind="fortinet-vpn",
            payload=dict(payload or VPN_PAYLOAD),
            visibility=visibility,
        )
    )


@pytest.fixture
def client(monkeypatch):
    holder = {"principal": ALICE}

    async def fake_principal(request, *, allow_as):
        return holder["principal"]

    monkeypatch.setattr(credentials_api, "_principal", fake_principal)
    app = FastAPI()
    app.include_router(credentials_api.router)
    app.include_router(vpn_api.router)
    c = TestClient(app)
    c.holder = holder  # type: ignore[attr-defined]
    return c


def folder_body(**over):
    body = {
        "name": "Tender documents",
        "vpn": "Office files",
        "share_path": r"\\FS01.office.local\Projects\Tenders\\",
        "share_username": "alice.share",
        "share_password": "s3cret-share",
        "trusted_for_import": True,
    }
    body.update(over)
    return body


def make_folder(client, file_store, **over):
    put_vpn(file_store, ALICE)
    r = client.post("/api/vpn/folders", json=folder_body(**over))
    assert r.status_code == 201, r.text
    return r.json()


# ---------------------------------------------------------------------------
# Kind + path normalisation
# ---------------------------------------------------------------------------


def test_kind_registered():
    spec = CREDENTIAL_KINDS["smb-folder"]
    assert spec.required == ("vpn", "share_path")
    assert spec.secret_fields == ("share_password",)
    assert spec.keep_secrets_on_put and not spec.materialize


@pytest.mark.parametrize(
    "payload",
    [
        {"vpn": "Office files", "share_path": "fs01/Projects"},
        {"vpn": "Office files", "share_path": "//fs01/Projects/../etc"},
        {"vpn": "Office files", "share_path": "//fs01"},
        {"vpn": "", "share_path": "//fs01/Projects"},
        {"vpn": "a/b", "share_path": "//fs01/Projects"},
        {"vpn": "x", "share_path": "//fs01/Projects", "share_password": "a\nb"},
        {"vpn": "x", "share_path": "//fs01/Projects", "share_username": "bob,uid=0"},
        {"vpn": "x", "share_path": "//fs01/Projects", "trusted_for_import": "yes"},
        {"vpn": "x", "share_path": "//fs01/Projects", "password": "extra"},
    ],
)
def test_bad_payload_rejected(payload):
    with pytest.raises(CredentialError):
        validate_payload("smb-folder", payload)


def test_redaction_and_no_materialization(file_store):
    payload = {
        "vpn": "Office files",
        "share_path": "//fs01/Projects",
        "share_username": "bob",
        "share_password": "pw",
    }
    assert "share_password" not in redact_payload("smb-folder", payload)
    run(
        file_store.put(
            OWNER,
            provider="fortinet",
            name="Tenders",
            kind="smb-folder",
            payload=payload,
        )
    )
    assert not [p for p in run(materialize_for_mounts(OWNER)) if "fortinet" in p]


@pytest.mark.parametrize(
    "raw, expected",
    [
        (r"\\fs01\Projects\Tenders", "//fs01/Projects/Tenders"),
        (
            "smb://FS01.office.local/Projects/Tenders/",
            "//fs01.office.local/Projects/Tenders",
        ),
        ("SMB://fs01/Projects", "//fs01/Projects"),
        ("//10.20.1.9/Share$/Q3 Reports", "//10.20.1.9/Share$/Q3 Reports"),
        ("  //fs01/Projects  ", "//fs01/Projects"),
    ],
)
def test_normalize_share_path(raw, expected):
    assert vpn_folders.normalize_share_path(raw) == expected


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "fs01/Projects",
        "///fs01/Projects",
        "//fs01",
        "//fs01//Projects",
        "//fs01/Projects/../x",
        "//fs01/Pro,jects",
        "//-x/Projects",
        "//fs01/Projects/a\x00b",
        "http://fs01/Projects",
    ],
)
def test_normalize_share_path_rejects(raw):
    with pytest.raises(vpn.VpnError):
        vpn_folders.normalize_share_path(raw)


def test_vpn_slugs_never_use_the_folder_prefix():
    assert vpn.slug_base("Net work") == "vpn-net-work"
    assert not vpn.slug_base("net-" + "x" * 60).startswith("net-")
    assert vpn.slug_base("Network") == "network"


# ---------------------------------------------------------------------------
# REST API (owner-only)
# ---------------------------------------------------------------------------


def test_create_list_never_returns_password(client, file_store, helper):
    view = make_folder(client, file_store)
    assert set(view) == VIEW_KEYS
    assert view["id"] == "net-tender-documents"
    assert view["share_path"] == "//fs01.office.local/Projects/Tenders"
    assert view["vpn_slug"] == "office-files"
    assert (
        view["has_share_password"] is True and view["share_username"] == "alice.share"
    )
    assert view["mount_path"].endswith("/net-tender-documents")
    assert view["status"] == {
        "vpn_state": "disconnected",
        "mounted": False,
        "error": None,
        "last_check": None,
    }
    r = client.get("/api/vpn/folders")
    assert r.status_code == 200 and "s3cret" not in r.text
    assert [f["name"] for f in r.json()["folders"]] == ["Tender documents"]
    r = client.get("/api/credentials")
    assert "s3cret-share" not in r.text
    stored = run(file_store.get(ALICE, "fortinet", "Tender documents"))
    assert stored.kind == "smb-folder" and stored.visibility == "private:alice"
    assert stored.payload["share_password"] == "s3cret-share"


def test_create_validation(client, file_store, helper):
    put_vpn(file_store, ALICE)
    for body, needle in [
        (folder_body(vpn="Nope"), "no VPN named"),
        (folder_body(share_path="fs01/Projects"), "SMB path"),
        (folder_body(name=""), "name is required"),
        (folder_body(trusted_for_import="yes"), "trusted_for_import"),
        (folder_body(share_username="bad,name"), "share_username"),
    ]:
        r = client.post("/api/vpn/folders", json=body)
        assert r.status_code == 400 and needle in r.json()["detail"], (body, r.text)
    assert client.post("/api/vpn/folders", json=["x"]).status_code == 400
    r = client.post("/api/vpn/folders", json=folder_body(name="Office files"))
    assert r.status_code == 400 and "already used by your VPN" in r.json()["detail"]


def test_vpn_must_be_readable_by_caller(client, file_store, helper):
    put_vpn(file_store, BOB, name="Bob private", visibility="private:bob")
    put_vpn(file_store, BOB, name="Bob shared", visibility="shared")
    r = client.post("/api/vpn/folders", json=folder_body(vpn="Bob private"))
    assert r.status_code == 400 and "no VPN named" in r.json()["detail"]
    r = client.post("/api/vpn/folders", json=folder_body(vpn="Bob shared"))
    assert r.status_code == 201, r.text


def test_other_users_get_404(client, file_store, helper):
    make_folder(client, file_store)
    client.holder["principal"] = BOB
    assert client.get("/api/vpn/folders").json() == {"folders": []}
    name = "Tender documents"
    assert client.put(f"/api/vpn/folders/{name}", json=folder_body()).status_code == 404
    assert client.delete(f"/api/vpn/folders/{name}").status_code == 404
    assert client.post(f"/api/vpn/folders/{name}/test").status_code == 404
    assert client.post(f"/api/vpn/folders/{name}/disconnect").status_code == 404
    # the owner of the box sees the entry in the store, but not in the Bridge API
    client.holder["principal"] = OWNER
    assert client.get("/api/vpn/folders").json() == {"folders": []}


def test_edit_keeps_password_and_rename_keeps_id(client, file_store, helper):
    view = make_folder(client, file_store)
    r = client.put(
        "/api/vpn/folders/Tender documents",
        json=folder_body(
            name="Tenders 2026", share_password="", trusted_for_import=False
        ),
    )
    assert r.status_code == 200, r.text
    edited = r.json()
    assert edited["id"] == view["id"] and edited["name"] == "Tenders 2026"
    assert (
        edited["trusted_for_import"] is False and edited["has_share_password"] is True
    )
    assert run(file_store.get(ALICE, "fortinet", "Tender documents")) is None
    stored = run(file_store.get(ALICE, "fortinet", "Tenders 2026"))
    assert stored.payload["share_password"] == "s3cret-share"
    # dropping the separate login drops its password too
    r = client.put(
        "/api/vpn/folders/Tenders 2026", json=folder_body(name=None, share_username="")
    )
    assert r.status_code == 200 and r.json()["has_share_password"] is False
    assert (
        "share_password"
        not in run(file_store.get(ALICE, "fortinet", "Tenders 2026")).payload
    )


def test_edit_of_mount_fields_unmounts(client, file_store, helper):
    make_folder(client, file_store)
    client.post("/api/vpn/folders/Tender documents/test")
    client.put(
        "/api/vpn/folders/Tender documents", json=folder_body(trusted_for_import=False)
    )
    assert "umount" not in helper.commands()
    client.put(
        "/api/vpn/folders/Tender documents", json=folder_body(share_path="//fs01/Other")
    )
    assert "umount" in helper.commands()


def test_generic_credentials_put_cannot_replace_a_folder(client, file_store, helper):
    make_folder(client, file_store)
    r = client.put(
        "/api/credentials/fortinet/Tender documents",
        json={"kind": "fortinet-vpn", "payload": VPN_PAYLOAD},
    )
    assert r.status_code == 409
    assert (
        run(file_store.get(ALICE, "fortinet", "Tender documents")).kind == "smb-folder"
    )


def test_test_mounts_and_records_check(client, file_store, helper):
    make_folder(client, file_store)
    r = client.post("/api/vpn/folders/Tender documents/test")
    assert r.status_code == 200, r.text
    view = r.json()
    assert (
        view["status"]["vpn_state"] == "connected" and view["status"]["mounted"] is True
    )
    assert view["status"]["last_check"]["ok"] is True
    assert view["status"]["last_check"]["file_count"] == 7
    commands = helper.commands()
    assert commands.index("up") < commands.index("mount") < commands.index("fcheck")
    (spec,) = helper.specs("mount")
    assert spec == {
        "vpn_slug": "office-files",
        "folder_slug": "tender-documents",
        "share_path": "//fs01.office.local/Projects/Tenders",
        "share_username": "alice.share",
        "share_password": "s3cret-share",
    }
    assert "s3cret" not in r.text


@pytest.mark.parametrize(
    "vpn_extra, folder_over, expected",
    [
        ({}, {"share_username": ""}, ("alice", "s3cret-vpn", None)),
        (
            {
                "share_username": "svc",
                "share_password": "vpn-share-pw",
                "share_domain": "CORP",
            },
            {"share_username": ""},
            ("svc", "vpn-share-pw", "CORP"),
        ),
        (
            {"share_username": "svc", "share_password": "vpn-share-pw"},
            {"share_domain": "LAB"},
            ("alice.share", "s3cret-share", "LAB"),
        ),
    ],
)
def test_share_login_resolution(
    client, file_store, helper, vpn_extra, folder_over, expected
):
    put_vpn(file_store, ALICE, payload={**VPN_PAYLOAD, **vpn_extra})
    assert (
        client.post("/api/vpn/folders", json=folder_body(**folder_over)).status_code
        == 201
    )
    client.post("/api/vpn/folders/Tender documents/test")
    (spec,) = helper.specs("mount")
    assert (
        spec["share_username"],
        spec.get("share_password"),
        spec.get("share_domain"),
    ) == expected


def test_test_reports_vpn_failure(client, file_store, helper):
    make_folder(client, file_store)
    helper.up_state, helper.up_error = (
        "error",
        "Login failed: wrong username or password",
    )
    view = client.post("/api/vpn/folders/Tender documents/test").json()
    assert view["status"]["mounted"] is False
    assert (
        view["status"]["error"]
        == "VPN connect failed: Login failed: wrong username or password"
    )
    assert view["status"]["last_check"]["ok"] is False
    assert "mount" not in helper.commands()


def test_test_reports_mount_failure(client, file_store, helper):
    make_folder(client, file_store)
    helper.mount_error = (
        "Share //fs01.office.local/Projects/Tenders was not found on the file server"
    )
    view = client.post("/api/vpn/folders/Tender documents/test").json()
    assert (
        view["status"]["vpn_state"] == "connected"
        and view["status"]["mounted"] is False
    )
    assert view["status"]["error"] == helper.mount_error
    assert view["status"]["last_check"]["message"] == helper.mount_error
    # a later success clears the error line
    helper.mount_error = None
    view = client.post("/api/vpn/folders/Tender documents/test").json()
    assert view["status"]["error"] is None and view["status"]["mounted"] is True


def test_disconnect_and_delete_unmount(client, file_store, helper):
    make_folder(client, file_store)
    client.post("/api/vpn/folders/Tender documents/test")
    view = client.post("/api/vpn/folders/Tender documents/disconnect").json()
    assert (
        view["status"]["mounted"] is False
        and view["status"]["vpn_state"] == "connected"
    )
    assert helper.calls[-3][:2] == ("umount", "tender-documents")
    r = client.delete("/api/vpn/folders/Tender documents")
    assert r.status_code == 200 and r.json() == {"ok": True}
    assert ("umount", "tender-documents", None) in helper.calls
    assert client.get("/api/vpn/folders").json() == {"folders": []}


def test_generic_delete_of_folder_unmounts(client, file_store, helper):
    make_folder(client, file_store)
    client.post("/api/vpn/folders/Tender documents/test")
    assert (
        client.delete("/api/credentials/fortinet/Tender documents").status_code == 200
    )
    assert helper.calls[-1][:2] == ("umount", "tender-documents")


def test_deleted_vpn_shows_in_folder_view(client, file_store, helper):
    make_folder(client, file_store)
    client.delete("/api/credentials/fortinet/Office files")
    (view,) = client.get("/api/vpn/folders").json()["folders"]
    assert (
        view["status"]["vpn_state"] == "error"
        and "was removed" in view["status"]["error"]
    )
    view = client.post("/api/vpn/folders/Tender documents/test").json()
    assert view["status"]["mounted"] is False


def test_agent_ensure_honours_auto_connect_off(file_store, helper):
    put_vpn(file_store, ALICE, payload={**VPN_PAYLOAD, "auto_connect": False})
    cred = run(
        file_store.put(
            ALICE,
            provider="fortinet",
            name="Tenders",
            kind="smb-folder",
            payload={"vpn": "Office files", "share_path": "//fs01/Projects"},
            visibility="private:alice",
        )
    )
    view = run(vpn_folders.ensure(cred, agent=True))
    assert (
        view["status"]["mounted"] is False
        and "Settings → In&Out" in view["status"]["error"]
    )
    assert "up" not in helper.commands()
    view = run(vpn_folders.ensure(cred))
    assert view["status"]["mounted"] is True


def _folder(store, name, **extra):
    return run(
        store.put(
            ALICE,
            provider="fortinet",
            name=name,
            kind="smb-folder",
            payload={"vpn": "Office files", "share_path": "//fs01/" + name, **extra},
            visibility="private:alice",
        )
    )


def test_vpn_reconnect_remounts_its_folders(file_store, helper):
    """The drop we hit on HSD: tunnel dies, auto-reconnect brings it back —
    and the folder mount comes back with it, without anything calling
    ensure first."""
    put_vpn(file_store, ALICE)
    cred = _folder(file_store, "Jensen")
    slug = vpn_folders.folder_slug_for(cred)
    assert run(vpn_folders.ensure(cred))["status"]["mounted"] is True
    run(vpn.disconnect(ALICE, "Office files"))
    assert helper.folders[slug]["mounted"] is False
    helper.calls.clear()
    run(vpn.connect(ALICE, "Office files"))
    assert helper.folders[slug]["mounted"] is True
    assert "mount" in helper.commands()


def test_reconnect_only_remounts_folders_that_were_ensured(file_store, helper):
    put_vpn(file_store, ALICE)
    used = _folder(file_store, "Used")
    never = _folder(file_store, "Never")
    run(vpn_folders.ensure(used))
    never_slug = vpn_folders.folder_slug_for(never)
    run(vpn.disconnect(ALICE, "Office files"))
    run(vpn.connect(ALICE, "Office files"))
    assert helper.folders[vpn_folders.folder_slug_for(used)]["mounted"] is True
    assert never_slug not in helper.folders


def test_folder_disconnect_clears_auto_mount(file_store, helper):
    put_vpn(file_store, ALICE)
    cred = _folder(file_store, "Seasonal")
    slug = vpn_folders.folder_slug_for(cred)
    run(vpn_folders.ensure(cred))
    run(vpn_folders.disconnect(ALICE, "Seasonal"))
    run(vpn.disconnect(ALICE, "Office files"))
    run(vpn.connect(ALICE, "Office files"))
    assert helper.folders[slug]["mounted"] is False


def test_remount_failure_is_recorded_not_raised(file_store, helper):
    put_vpn(file_store, ALICE)
    cred = _folder(file_store, "Fragile")
    run(vpn_folders.ensure(cred))
    run(vpn.disconnect(ALICE, "Office files"))
    helper.mount_error = "share offline"
    view = run(vpn.connect(ALICE, "Office files"))  # connect still succeeds
    assert view["status"]["state"] == "connected"
    assert helper.folders[vpn_folders.folder_slug_for(cred)]["mounted"] is False


def test_ensure_folder_cli_by_id_and_name(file_store, helper, capsys):
    put_vpn(file_store, ALICE)
    cred = _folder(file_store, "BridgeDocs")
    fid = vpn_folders.folder_id(vpn_folders.folder_slug_for(cred))
    from hermes_cli.vpn_cmd import vpn_command
    import argparse

    rc = vpn_command(argparse.Namespace(vpn_command="ensure-folder", name=fid, json=False))
    out = capsys.readouterr().out
    assert rc == 0 and "mounted" in out and "BridgeDocs" in out

    run(vpn_folders.disconnect(ALICE, "BridgeDocs"))
    rc = vpn_command(argparse.Namespace(vpn_command="ensure-folder", name="BridgeDocs", json=False))
    assert rc == 0
    assert helper.folders[vpn_folders.folder_slug_for(cred)]["mounted"] is True


# ---------------------------------------------------------------------------
# Internal (app-mcp) routes
# ---------------------------------------------------------------------------


@pytest.fixture
def internal(monkeypatch):
    from hermes_cli.dashboard_auth.registry import clear_providers
    from hermes_cli.dashboard_auth.token_auth import clear_token_routes

    clear_providers()
    clear_token_routes()
    monkeypatch.setenv(vpn_api.APP_MCP_TOKEN_ENV, TOKEN)
    vpn_api.install_internal_auth()
    vpn_api.install_internal_auth()  # idempotent
    app = FastAPI()
    app.include_router(vpn_api.internal_router)
    app.middleware("http")(token_auth_middleware)
    yield TestClient(app)
    clear_providers()
    clear_token_routes()


AUTH = {"Authorization": f"Bearer {TOKEN}"}


def _alice_and_bob_folders(file_store, trusted=False):
    put_vpn(file_store, ALICE)
    for who, name in ((ALICE, "Tenders"), (BOB, "Bob docs")):
        run(
            file_store.put(
                who,
                provider="fortinet",
                name=name,
                kind="smb-folder",
                payload={
                    "vpn": "Office files",
                    "share_path": "//10.20.1.9/Projects",
                    "trusted_for_import": trusted,
                },
                visibility=who.private_visibility,
            )
        )


def test_internal_auth(internal, monkeypatch, file_store, helper):
    assert internal.get("/api/internal/vpn/folders").status_code == 401
    bad = {"Authorization": "Bearer " + "x" * 40}
    assert internal.get("/api/internal/vpn/folders", headers=bad).status_code == 401
    r = internal.get(
        "/api/internal/vpn/folders", headers={**AUTH, "X-Forwarded-For": "1.2.3.4"}
    )
    assert r.status_code == 403
    assert internal.get("/api/internal/vpn/folders", headers=AUTH).status_code == 200
    monkeypatch.setenv(vpn_api.APP_MCP_TOKEN_ENV, "short")
    assert (
        internal.get(
            "/api/internal/vpn/folders", headers={"Authorization": "Bearer short"}
        ).status_code
        == 401
    )


def test_internal_list_is_box_wide_and_ensure_mounts(internal, file_store, helper):
    _alice_and_bob_folders(file_store)
    folders = internal.get("/api/internal/vpn/folders", headers=AUTH).json()["folders"]
    assert sorted(f["name"] for f in folders) == ["Bob docs", "Tenders"]
    bob = next(f for f in folders if f["name"] == "Bob docs")
    # Bob's folder points at Alice's private VPN, which Bob can't read
    assert bob["status"]["vpn_state"] == "error"
    r = internal.post(
        "/api/internal/vpn/folders/ensure", json={"id": "net-tenders"}, headers=AUTH
    )
    assert r.status_code == 200 and r.json()["folder"]["mounted"] is True
    assert "password" not in r.text
    r = internal.post(
        "/api/internal/vpn/folders/ensure", json={"id": "net-nope"}, headers=AUTH
    )
    assert r.status_code == 404
    r = internal.post(
        "/api/internal/vpn/folders/ensure", json={"id": "../x"}, headers=AUTH
    )
    assert r.status_code == 404


class FakeStorage:
    bucket = "agent-home-media"

    def __init__(self):
        self.objects: Dict[str, bytes] = {}

    async def upload_stream(self, path, chunks, *, size, content_type):
        data = b"".join([c async for c in chunks])
        assert len(data) == size
        self.objects[path] = data
        return path


class FakeRegistry:
    def __init__(self):
        self.rows: List[Dict[str, Any]] = []

    async def initialize(self):
        return None

    async def register(self, principal, **fields):
        self.rows.append({"owner": principal.user_id, **fields})

        class Asset:
            id = "asset-1"
            filename = fields["filename"]

        return Asset()


def test_import_gating_and_copy(file_store, helper):
    _alice_and_bob_folders(file_store)
    out = run(vpn_folders.import_file("net-tenders", "a.pdf", approved=False))
    assert out["ok"] is False and out["needsApproval"] is True
    assert "mount" not in helper.commands()
    run(vpn_folders.ensure(run(vpn_folders.find_by_id("net-tenders"))))
    root = Path(vpn.MOUNT_ROOT, "net-tenders")
    (root / "2026").mkdir()
    data = os.urandom(9 * 1024 * 1024 + 7)
    (root / "2026" / "Bid.pdf").write_bytes(data)
    storage, registry = FakeStorage(), FakeRegistry()
    out = run(
        vpn_folders.import_file(
            "net-tenders",
            "2026/Bid.pdf",
            approved=True,
            storage=storage,
            registry=registry,
        )
    )
    digest = hashlib.sha256(data).hexdigest()
    assert out == {
        "ok": True,
        "folderId": "net-tenders",
        "path": "2026/Bid.pdf",
        "assetId": "asset-1",
        "filename": "Bid.pdf",
        "size": len(data),
        "sha256": digest,
        "storageBucket": "agent-home-media",
        "storagePath": out["storagePath"],
        "verified": True,
    }
    assert out["storagePath"].startswith("alice/files/")
    assert storage.objects[out["storagePath"]] == data
    (row,) = registry.rows
    assert row["owner"] == "alice" and row["surface"] == "agent_home"
    assert (
        row["conversation"] == "Tenders/2026/Bid.pdf"
        and row["content_type"] == "application/pdf"
    )


@pytest.mark.parametrize("path", ["../escape.txt", "2026/../../x", "", "/", "2026"])
def test_import_refuses_traversal_and_dirs(file_store, helper, tmp_path, path):
    _alice_and_bob_folders(file_store, trusted=True)
    run(vpn_folders.ensure(run(vpn_folders.find_by_id("net-tenders"))))
    Path(vpn.MOUNT_ROOT, "net-tenders", "2026").mkdir()
    Path(vpn.MOUNT_ROOT, "escape.txt").write_text("outside")
    with pytest.raises(vpn.VpnError):
        run(
            vpn_folders.import_file(
                "net-tenders",
                path,
                approved=False,
                storage=FakeStorage(),
                registry=FakeRegistry(),
            )
        )


def test_import_refuses_symlinks(file_store, helper, tmp_path):
    _alice_and_bob_folders(file_store, trusted=True)
    run(vpn_folders.ensure(run(vpn_folders.find_by_id("net-tenders"))))
    root = Path(vpn.MOUNT_ROOT, "net-tenders")
    secret = tmp_path / "secret.txt"
    secret.write_text("root only")
    os.symlink(secret, root / "link.txt")
    os.symlink(tmp_path, root / "dirlink")
    for path in ("link.txt", "dirlink/secret.txt"):
        with pytest.raises(vpn.VpnError):
            run(
                vpn_folders.import_file(
                    "net-tenders",
                    path,
                    approved=False,
                    storage=FakeStorage(),
                    registry=FakeRegistry(),
                )
            )


def test_internal_import_route(internal, file_store, helper, monkeypatch):
    _alice_and_bob_folders(file_store, trusted=False)
    r = internal.post(
        "/api/internal/vpn/folders/import",
        json={"id": "net-tenders", "path": "a.txt"},
        headers=AUTH,
    )
    assert r.status_code == 200 and r.json()["needsApproval"] is True
    r = internal.post(
        "/api/internal/vpn/folders/import",
        json={"id": "net-tenders", "path": "../a.txt", "approved": True},
        headers=AUTH,
    )
    assert r.status_code == 200 and r.json()["ok"] is False
    r = internal.post(
        "/api/internal/vpn/folders/import",
        json={"id": "net-zzz", "path": "a.txt"},
        headers=AUTH,
    )
    assert r.status_code == 404
