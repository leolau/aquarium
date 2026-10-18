"""``hermes vpn migrate-shares`` against the Supabase credential store
(throwaway Postgres, same fixture as ``test_credential_store_e2e.py``):
folders keep the VPN owner's identity and visibility under RLS. Skips when
Docker is unavailable."""

from __future__ import annotations

import pytest

from hermes_cli import vpn
from tests.hermes_cli.test_credential_store_e2e import _setup, postgres_dsn  # noqa: F401

PAYLOAD = {
    "host": "vpn.example.com",
    "username": "alice",
    "password": "s3cret-vpn",
    "routes": ["10.20.0.0/16"],
    "share_path": r"\\192.168.0.91\Share-Folder",
    "share_username": "svc",
    "share_password": "s3cret-share",
}


@pytest.mark.asyncio
async def test_migrate_shares_on_supabase(postgres_dsn: str) -> None:  # noqa: F811
    store, owner, alice, bob = await _setup(postgres_dsn)
    await store.put(
        alice,
        provider="fortinet",
        name="Office",
        kind="fortinet-vpn",
        payload=PAYLOAD,
        visibility=alice.private_visibility,
    )
    await store.put(
        bob,
        provider="fortinet",
        name="Bare",
        kind="fortinet-vpn",
        payload={"host": "vpn.example.com", "username": "bob", "password": "pw"},
        visibility="shared",
    )

    dry = await vpn.migrate_shares(dry_run=True, store=store)
    assert any("would move share //192.168.0.91/Share-Folder" in line for line in dry)
    assert await store.get(alice, "fortinet", "Share-Folder") is None

    lines = await vpn.migrate_shares(store=store)
    assert "s3cret" not in "\n".join(lines)
    folder = await store.get(alice, "fortinet", "Share-Folder")
    assert folder is not None and folder.kind == "smb-folder"
    assert folder.owner_user_id == alice.user_id
    assert folder.visibility == alice.private_visibility
    assert folder.payload["vpn"] == "Office"
    assert folder.payload["share_username"] == "svc"
    assert folder.payload["share_password"] == "s3cret-share"
    assert await store.get(bob, "fortinet", "Share-Folder") is None
    migrated = await store.get(alice, "fortinet", "Office")
    assert migrated is not None and migrated.visibility == alice.private_visibility
    assert not {"share_path", "share_username", "share_password", "routes"} & set(
        migrated.payload
    )

    again = await vpn.migrate_shares(store=store)
    assert all("nothing to migrate" in line for line in again), again
