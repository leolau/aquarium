#!/usr/bin/env python3
"""Save a site login to the unified credential store (kind ``password``).

The password is read from stdin (one line) or an environment variable --
never from argv -- and is never printed. The entry is stored under
provider ``web-login`` by default, so ``auth_crawl.py --credential
web-login/<name>`` can use it later.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path
from typing import Optional, Sequence

PROVIDER = "web-login"


def _import_store():
    repo_root = Path(os.environ.get("HERMES_AGENT_ROOT") or Path(__file__).resolve().parents[4])
    if str(repo_root) not in sys.path:
        sys.path.insert(0, str(repo_root))
    from hermes_cli import credential_store  # type: ignore

    return credential_store


def save(name: str, username: str, password: str, *, provider: str = PROVIDER) -> str:
    """Store the login; returns ``provider/name``."""
    cs = _import_store()

    async def _put() -> None:
        store = cs.default_credential_store()
        principal = await cs.resolve_owner_principal()
        await store.put(
            principal,
            provider=provider,
            name=name,
            kind="password",
            payload={"username": username, "password": password},
        )

    asyncio.run(_put())
    return f"{provider}/{name}"


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Save a site login (password never on argv).")
    parser.add_argument("--name", required=True, help="entry name, e.g. the site host")
    parser.add_argument("--username", required=True, help="login name (not a secret)")
    parser.add_argument("--provider", default=PROVIDER)
    parser.add_argument(
        "--password-env",
        default="AUTH_CRAWL_PASSWORD",
        help="env var holding the password when stdin is not used",
    )
    parser.add_argument("--password-stdin", action="store_true", help="read the password from stdin")
    args = parser.parse_args(argv)
    if args.password_stdin:
        password = sys.stdin.readline().rstrip("\n")
    else:
        password = os.environ.get(args.password_env, "")
    if not password:
        print("no password given (use --password-stdin or set the env var)", file=sys.stderr)
        return 1
    try:
        ref = save(args.name, args.username, password, provider=args.provider)
    except Exception as exc:
        print(f"could not save: {str(exc).replace(password, '[redacted]')}", file=sys.stderr)
        return 1
    print(f"saved {ref} (username {args.username}); use --credential {ref}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
