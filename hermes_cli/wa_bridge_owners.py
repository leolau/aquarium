"""Which person each WhatsApp bridge belongs to.

Each bridge (``hermes-wa-bridge-<name>.service``, session dir
``<HERMES_HOME>/whatsapp/session-<name>``) is one person's phone. The person
who added it in Settings is recorded here; only they can see its QR, control
it, or send through it, and the gateway handles its messages only as them.

Bridges with no record (made before per-person bridges, e.g. by hand on an
existing box) belong to the install owner and keep their old routing.

Stored in ``<HERMES_HOME>/whatsapp/bridge-owners.json`` (0600, written by the
dashboard): ``{"<name>": {"user_id": "...", "port": 3002, "added_at": 0}}``.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Dict, Optional

OWNERS_FILE = "bridge-owners.json"
_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,30}$")
_lock = threading.Lock()


def whatsapp_dir() -> Path:
    home = os.environ.get("HERMES_HOME") or str(Path.home() / ".hermes")
    return Path(home) / "whatsapp"


def session_dir(name: str) -> Path:
    return whatsapp_dir() / f"session-{name}"


def _path() -> Path:
    return whatsapp_dir() / OWNERS_FILE


def load_owners() -> Dict[str, Dict[str, Any]]:
    try:
        data = json.loads(_path().read_text())
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {
        str(k): v for k, v in data.items()
        if isinstance(v, dict) and isinstance(v.get("user_id"), str) and v["user_id"]
    }


def bridge_person(name: str) -> Optional[str]:
    """The user_id who added bridge ``name``, or ``None`` (install owner's)."""
    rec = load_owners().get(name)
    return rec["user_id"] if rec else None


def recorded_port(name: str) -> Optional[int]:
    rec = load_owners().get(name) or {}
    port = rec.get("port")
    return port if isinstance(port, int) and port > 0 else None


def record_owner(name: str, user_id: str, *, port: Optional[int] = None) -> None:
    if not _NAME_RE.match(name):
        raise ValueError(f"invalid bridge name: {name!r}")
    if not user_id:
        raise ValueError("a bridge needs a person")
    with _lock:
        owners = load_owners()
        rec: Dict[str, Any] = {"user_id": user_id, "added_at": int(time.time())}
        if port:
            rec["port"] = int(port)
        owners[name] = rec
        directory = whatsapp_dir()
        directory.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(directory), prefix=".bridge-owners-")
        try:
            with os.fdopen(fd, "w") as fh:
                json.dump(owners, fh, indent=2, sort_keys=True)
            os.chmod(tmp, 0o600)
            os.replace(tmp, _path())
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise


def own_number(name: str) -> Optional[str]:
    """Digits of the phone number linked to bridge ``name`` (from creds.json)."""
    try:
        creds = json.loads((session_dir(name) / "creds.json").read_text())
    except (OSError, ValueError):
        return None
    me = creds.get("me") if isinstance(creds, dict) else None
    jid = str((me or {}).get("id") or "")
    digits = re.split(r"[:@]", jid, maxsplit=1)[0]
    return digits if digits.isdigit() else None


def mask_number(digits: Optional[str]) -> Optional[str]:
    if not digits:
        return None
    if len(digits) <= 7:
        return f"+{digits[:1]}****{digits[-2:]}"
    return f"+{digits[:3]}****{digits[-4:]}"


def bridge_name_for_session_path(path: Any) -> Optional[str]:
    """``session-<name>`` under the WhatsApp dir → ``<name>``; else ``None``."""
    try:
        p = Path(str(path)).expanduser()
    except Exception:
        return None
    if not p.name.startswith("session-"):
        return None
    name = p.name[len("session-"):]
    return name if _NAME_RE.match(name) else None
