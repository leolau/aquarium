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


_UNREACHABLE = (
    "the credential store is not reachable from this terminal; use the site_db tool instead: "
    "action explore / preview (site=<slug>), which logs in with the site's saved login"
)


def load_credential(entry: str) -> Any:
    """The ``provider/name`` entry from the box's credential store (kind ``password``).

    The returned object goes straight to the runner, which types the password
    into the login form; nothing here prints or returns it.
    """
    provider, _, name = entry.partition("/")
    if not provider or not name:
        raise SystemExit("--credential expects provider/name, e.g. web-login/hsdos.eshf-it.com")
    if os.environ.get("HERMES_TERMINAL_DB_CREDENTIALS_HIDDEN") == "1":
        raise SystemExit(_UNREACHABLE + " (this terminal does not get the database credentials)")
    try:
        repo_root()
        from hermes_cli.credential_store import default_credential_store, resolve_owner_principal

        async def _load() -> Any:
            store = default_credential_store()
            principal = await resolve_owner_principal()
            return await store.get(principal, provider, name)

        credential = asyncio.run(_load())
    except Exception as exc:  # noqa: BLE001 - any failure here means "not from this terminal"
        raise SystemExit(f"{_UNREACHABLE} ({type(exc).__name__}: {str(exc)[:200]})") from None
    if credential is None:
        raise SystemExit(
            f"credential {entry} not found. Save it with "
            "skills/research/auth-web-crawler/scripts/save_login.py, or use the site_db tool "
            "(action explore / preview), which logs in with the site's saved login"
        )
    if credential.kind != "password":
        raise SystemExit(f"credential {entry} is kind {credential.kind!r}, not 'password'")
    return credential
