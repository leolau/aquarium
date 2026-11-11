"""Shared helpers for the site-to-schema skill scripts."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any


def repo_root() -> Path:
    root = Path(os.environ.get("HERMES_AGENT_ROOT") or Path(__file__).resolve().parents[4])
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    return root


def load_json(path: str) -> Any:
    with open(os.path.expanduser(path), encoding="utf-8") as fh:
        return json.load(fh)


def load_credential(entry: str) -> Any:
    """The ``provider/name`` entry from the box's credential store (kind ``password``).

    The returned object goes straight to the runner, which types the password
    into the login form; nothing here prints or returns it.
    """
    provider, _, name = entry.partition("/")
    if not provider or not name:
        raise SystemExit("--credential expects provider/name, e.g. web-login/hsdos.eshf-it.com")
    repo_root()
    from hermes_cli.credential_store import default_credential_store, resolve_owner_principal

    async def _load() -> Any:
        store = default_credential_store()
        principal = await resolve_owner_principal()
        return await store.get(principal, provider, name)

    credential = asyncio.run(_load())
    if credential is None:
        raise SystemExit(
            f"credential {entry} not found; save it with "
            "skills/research/auth-web-crawler/scripts/save_login.py"
        )
    if credential.kind != "password":
        raise SystemExit(f"credential {entry} is kind {credential.kind!r}, not 'password'")
    return credential
