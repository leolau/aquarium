"""Checks and migrations the root ``aquarium`` admin command runs inside a release.

``/usr/local/sbin/aquarium`` (deploy/aquarium.py) is stdlib-only and never imports
Aquarium code as root. For anything that needs the app's own code it runs

    runuser -u hermes -- <release>/.venv/bin/python -I -m hermes_cli.aquarium_probe <check>

with the app env loaded. Each check prints one JSON object per line on stdout
(``{"check": ..., "status": "ok"|"warn"|"fail", "message": ..., "fix": ...}``) and
never prints a secret value.

    migrate     database schema/roles (same steps as install-aquarium.sh) + config.yaml
    model-key   the configured model provider accepts its API key (no tokens spent)
    google      every connected Google account can still refresh its access token
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import urllib.error
import urllib.request
from typing import Any, Dict, List

HTTP_TIMEOUT = 15.0


def _emit(check: str, status: str, message: str, fix: str = "") -> Dict[str, str]:
    row = {"check": check, "status": status, "message": message, "fix": fix}
    print(json.dumps(row), flush=True)
    return row


def migrate(admin_dsn: str = "") -> int:
    """Idempotent upgrade steps; safe to run on every update.

    ``admin_dsn`` is the schema owner's address from /etc/aquarium/db-admin.env
    (given on stdin with ``--dsn-stdin``); without it the configured one is used.
    """
    from hermes_cli.config import migrate_config

    migrate_config(interactive=False, quiet=True)
    _emit("config", "ok", "config.yaml is on the current schema")

    from hermes_cli.datastore import get_store

    if not get_store("supabase-app", "prod").dsn:
        _emit("database", "ok", "no Supabase datastore configured; nothing to migrate")
        return 0

    from hermes_cli.db_migrate import migrate as migrate_db

    failed = [f"{mode} {name}: {error}" for mode, name, error in migrate_db(admin_dsn) if error]
    if failed:
        _emit("database", "fail", "; ".join(failed)[:500],
              "Run `hermes db migrate` with the schema owner's address for details.")
        return 1
    _emit("database", "ok", "database schema and roles are up to date")
    return 0


def _models_request(runtime: Dict[str, Any]) -> urllib.request.Request:
    base = str(runtime.get("base_url") or "").rstrip("/")
    key = str(runtime.get("api_key") or "")
    mode = str(runtime.get("api_mode") or "")
    if mode == "anthropic_messages" or "anthropic.com" in base:
        root = base[: -len("/v1")] if base.endswith("/v1") else base
        return urllib.request.Request(
            f"{root}/v1/models",
            headers={"x-api-key": key, "anthropic-version": "2023-06-01"},
        )
    return urllib.request.Request(f"{base}/models", headers={"Authorization": f"Bearer {key}"})


def model_key() -> int:
    from hermes_cli.runtime_provider import resolve_runtime_provider

    fix_page = "Add or replace the key in Settings → Models (or $HERMES_HOME/.env), then run `aquarium doctor` again."
    try:
        runtime = resolve_runtime_provider()
    except Exception as error:  # the resolver's own errors are user-facing text
        _emit("model key", "fail", f"no usable model provider is configured ({type(error).__name__})", fix_page)
        return 1
    provider = runtime.get("provider") or "unknown"
    if not runtime.get("api_key"):
        _emit("model key", "fail", f"provider {provider} has no API key", fix_page)
        return 1
    if not runtime.get("base_url"):
        _emit("model key", "warn", f"provider {provider} has a key but no API address to test it against")
        return 0
    try:
        with urllib.request.urlopen(_models_request(runtime), timeout=HTTP_TIMEOUT) as response:
            code = response.status
    except urllib.error.HTTPError as error:
        code = error.code
    except (urllib.error.URLError, OSError) as error:
        _emit("model key", "fail", f"cannot reach {provider} ({error.__class__.__name__})",
              "Check the server's internet connection and DNS, then try again.")
        return 1
    if code in (401, 403):
        _emit("model key", "fail", f"{provider} rejected the API key (HTTP {code})",
              "The key is wrong, revoked or out of credit. " + fix_page)
        return 1
    if code >= 500:
        _emit("model key", "warn", f"{provider} answered HTTP {code}; the provider may be having an outage")
        return 0
    _emit("model key", "ok", f"{provider} accepts the API key")
    return 0


async def _google_credentials() -> List[Any]:
    from hermes_cli.credential_store import default_credential_store, resolve_owner_principal

    store = default_credential_store()
    owner = await resolve_owner_principal()
    if owner is None:
        return []
    return [c for c in await store.list(owner) if c.kind == "google-oauth2"]


def google() -> int:
    from hermes_cli.google_oauth import refresh_access_token

    try:
        creds = asyncio.run(_google_credentials())
    except Exception as error:
        _emit("google", "fail", f"cannot read connected accounts ({type(error).__name__})",
              "Check the database with `aquarium doctor` (DB line) first.")
        return 1
    if not creds:
        _emit("google", "ok", "no Google account connected (nothing to check)")
        return 0
    failed = 0
    for cred in creds:
        label = f"{cred.name} (user {cred.owner_user_id})"
        payload = cred.payload
        try:
            refresh_access_token(
                client_id=payload.get("client_id", ""),
                client_secret=payload.get("client_secret", ""),
                refresh_token=payload.get("refresh_token", ""),
            )
        except Exception as error:
            failed += 1
            reason = str(error).splitlines()[0][:120] if str(error) else type(error).__name__
            _emit("google", "fail", f"Google account {label} can no longer refresh its token: {reason}",
                  "That person must reconnect it in Settings → Connected accounts. If every account "
                  "fails about 7 days after connecting, the Google OAuth app is still in 'Testing' "
                  "mode: publish it in Google Cloud Console → OAuth consent screen.")
        else:
            _emit("google", "ok", f"Google account {label} is connected")
    return 1 if failed else 0


CHECKS = {"migrate": migrate, "model-key": model_key, "google": google}


def main(argv: List[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m hermes_cli.aquarium_probe")
    parser.add_argument("check", choices=sorted(CHECKS))
    parser.add_argument("--dsn-stdin", action="store_true",
                        help="migrate: read the schema owner's address from stdin")
    args = parser.parse_args(argv)
    if args.check == "migrate" and args.dsn_stdin:
        from hermes_cli.db_migrate import parse_dsn

        return migrate(parse_dsn(sys.stdin.read()))
    return CHECKS[args.check]()


if __name__ == "__main__":
    sys.exit(main())
