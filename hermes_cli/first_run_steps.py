"""First-run setup steps that run before the owner's first sign-in (P2 screen 1).

The /setup page saves the AI model key, the timezone and the language and checks
a domain name while the person holding the one-time ``hermes setup-link`` token
fills in the form. Every step is allowed only while that token is valid (unused,
unexpired) and the owner's first-run login has not been created yet; after
``first_run.create_owner`` succeeds the token is used up and a ``done`` marker
is written, so these steps refuse from then on even if a new link is minted.
"""
from __future__ import annotations

import ipaddress
import json
import os
import re
import socket
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Optional

from hermes_cli import first_run
from hermes_cli.invitations import RedeemThrottle
from hermes_constants import get_hermes_home

# The page makes several calls per link (check, key test, region, domain, owner),
# so steps get their own, roomier budget than the owner-creation throttle.
STEP_THROTTLE = RedeemThrottle(max_attempts=40, window_seconds=300.0, ip_max_attempts=80)

# provider id (as used in config.yaml model.provider) -> the .env key it reads.
SETUP_PROVIDERS: dict[str, str] = {
    "openrouter": "OPENROUTER_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "openai-api": "OPENAI_API_KEY",
    "deepseek": "DEEPSEEK_API_KEY",
    "gemini": "GEMINI_API_KEY",
}

LANGUAGES = ("en", "zh-Hant")

_HOST_RE = re.compile(
    r"^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$"
)


def done_path(home: Optional[Path] = None) -> Path:
    return (home or get_hermes_home()) / "auth" / "first_run_done.json"


def mark_done(home: Optional[Path] = None) -> None:
    path = done_path(home)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"at": datetime.now(timezone.utc).isoformat()}))


def is_done(home: Optional[Path] = None) -> bool:
    return done_path(home).exists()


def step_allowed(token: str, *, ip: str, home: Optional[Path] = None) -> bool:
    """May this request run a first-run step? Same answer for every refusal."""
    if not token or not STEP_THROTTLE.allow(ip=ip, token=token):
        return False
    return not is_done(home) and first_run.check(token, home=home)


def recommended_model(provider: str) -> str:
    """The model a first-run chat uses for ``provider`` (changeable later in Models)."""
    from hermes_cli.models import OPENROUTER_MODELS, get_default_model_for_provider

    if provider == "openrouter":
        tagged = [mid for mid, note in OPENROUTER_MODELS if note == "recommended"]
        return (tagged or [mid for mid, _ in OPENROUTER_MODELS] or [""])[0]
    return get_default_model_for_provider(provider)


def valid_timezone(name: str) -> bool:
    name = (name or "").strip()
    if not name or len(name) > 64:
        return False
    try:
        from zoneinfo import ZoneInfo

        ZoneInfo(name)
    except Exception:  # noqa: BLE001 — any lookup failure means "not a zone"
        return False
    return True


def normalize_host(raw: str) -> str:
    """``https://Aquarium.Example.com/x`` -> ``aquarium.example.com``; "" if not a host."""
    host = (raw or "").strip().lower()
    host = re.sub(r"^[a-z]+://", "", host).split("/", 1)[0].split(":", 1)[0].rstrip(".")
    return host if _HOST_RE.match(host) else ""


def _public(addr: str) -> bool:
    try:
        ip = ipaddress.ip_address(addr.split("%", 1)[0])
    except ValueError:
        return False
    return not (ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_unspecified)


def server_addresses() -> list[str]:
    """This server's own network addresses (loopback / link-local left out)."""
    found: set[str] = set()
    try:
        import psutil

        for addrs in psutil.net_if_addrs().values():
            for addr in addrs:
                if addr.family in (socket.AF_INET, socket.AF_INET6) and _public(addr.address):
                    found.add(addr.address.split("%", 1)[0])
    except Exception:  # noqa: BLE001 — fall through with whatever we found
        pass
    return sorted(found)


def resolve(host: str) -> list[str]:
    try:
        infos = socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)
    except OSError:
        return []
    return sorted({info[4][0] for info in infos})


def https_ready(host: str, timeout: float = 6.0) -> bool:
    """Does https://<host>/ answer with a certificate the system trusts?"""
    import httpx

    try:
        with httpx.Client(timeout=httpx.Timeout(timeout), follow_redirects=False) as client:
            client.get(f"https://{host}/")
    except Exception:  # noqa: BLE001 — no answer / bad certificate = not ready
        return False
    return True


def check_domain(host: str, *, addresses: Optional[Iterable[str]] = None,
                 resolver=resolve, https_probe=https_ready) -> dict[str, Any]:
    """Read-only domain check. HTTPS is only probed once the name points here,
    so this cannot be used to make the server call arbitrary hosts."""
    mine = sorted(set(addresses if addresses is not None else server_addresses()))
    resolved = resolver(host)
    points_here = bool(set(resolved) & set(mine))
    return {
        "ok": True,
        "host": host,
        "resolves": bool(resolved),
        "points_here": points_here,
        "https_ready": bool(points_here and https_probe(host)),
        "server_addresses": [a for a in mine if ":" not in a] or mine,
    }


def env_snapshot(key: str) -> Optional[str]:
    """Current value of ``key`` in the .env file (None if unset), for rollback."""
    from hermes_cli.config import load_env

    value = load_env().get(key)
    return value if value else None


def restore_model(env_key: str, previous_key: Optional[str], previous_model: Any) -> None:
    """Put the .env key and config.yaml ``model`` back as they were."""
    from hermes_cli.config import load_config, remove_env_value, save_config, save_env_value

    if previous_key is None:
        remove_env_value(env_key)
        os.environ.pop(env_key, None)
    else:
        save_env_value(env_key, previous_key)
    cfg = load_config()
    if previous_model is None:
        cfg.pop("model", None)
    else:
        cfg["model"] = previous_model
    save_config(cfg)


def write_region(*, timezone_name: str, language: str) -> None:
    from hermes_cli.config import load_config, save_config

    cfg = load_config()
    cfg["timezone"] = timezone_name
    agent_home = cfg.get("agent_home") if isinstance(cfg.get("agent_home"), dict) else {}
    agent_home["language"] = language
    cfg["agent_home"] = agent_home
    save_config(cfg)


__all__ = [
    "LANGUAGES", "SETUP_PROVIDERS", "STEP_THROTTLE", "check_domain", "done_path",
    "env_snapshot", "is_done", "mark_done", "normalize_host", "recommended_model", "restore_model",
    "server_addresses",
    "step_allowed", "valid_timezone", "write_region",
]
