"""Per-person interface preferences: the agent-home language and the
Projects view mode (Task mode or Project mode, one choice per device class).

One small JSON file per login under ``<root>/auth/user_prefs/``, named by a
hash of the account id so an id can never become a path. ``<root>`` is the box
root the profile registry hangs off, never a profile home: preferences belong
to the login, which is box-wide, so a request scoped to another profile reads
and writes the same file (FG-28 B5).
Files are 0600 in a 0700 directory, written atomically. Nothing here is a
secret; it lives under ``auth/`` because that is where per-login runtime
state already goes (the checkout may be root-owned).

A person only ever reads or writes their own file: the web routes pass the
signed-in account's id (``two_factor.principal_id_for_session``) and never
take one from the request.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path
from typing import Any, Dict, Optional

import hermes_constants

#: Languages agent-home ships strings for. ``en`` is the default.
SUPPORTED_LANGUAGES = ("en", "zh-Hant")


def _prefs_dir() -> Path:
    return hermes_constants.get_default_hermes_root() / "auth" / "user_prefs"


def _legacy_prefs_dir() -> Optional[Path]:
    """A pre-FG-28 process's own ``HERMES_HOME`` store, when that is not the root.

    On a standard install the default profile home *is* the root, so this is
    ``None``; only a process launched with a named profile home has older
    files to read (a save moves them to the root).
    """
    launched = os.environ.get("HERMES_HOME", "").strip()
    if not launched:
        return None
    legacy = Path(launched) / "auth" / "user_prefs"
    if hermes_constants.resolve_path_cached(legacy) == hermes_constants.resolve_path_cached(_prefs_dir()):
        return None
    return legacy


def _prefs_name(user_id: str) -> str:
    if not isinstance(user_id, str) or not user_id.strip():
        raise ValueError("user_id is required")
    return hashlib.sha256(user_id.encode("utf-8")).hexdigest()[:40] + ".json"


def _prefs_path(user_id: str) -> Path:
    return _prefs_dir() / _prefs_name(user_id)


def _read_doc(path: Path, user_id: str) -> Optional[Dict[str, Any]]:
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(doc, dict) or doc.get("user_id") != user_id:
        return None
    return doc


def read_prefs(user_id: str) -> Dict[str, Any]:
    """This person's saved preferences, ``{}`` when none are saved."""
    doc = _read_doc(_prefs_path(user_id), user_id)
    if doc is None:
        legacy = _legacy_prefs_dir()
        if legacy is not None:
            doc = _read_doc(legacy / _prefs_name(user_id), user_id)
    return doc or {}


def get_language(user_id: str) -> Optional[str]:
    """The saved language, or ``None`` when this person never picked one."""
    value = read_prefs(user_id).get("language")
    return value if value in SUPPORTED_LANGUAGES else None


def set_language(user_id: str, language: str) -> str:
    """Save ``language`` for this person; raises ``ValueError`` if unsupported."""
    if language not in SUPPORTED_LANGUAGES:
        raise ValueError(
            f"unsupported language {language!r}; use one of {', '.join(SUPPORTED_LANGUAGES)}"
        )
    _write(user_id, {"language": language})
    return language


#: The two views of a project and the device classes a choice is kept for.
PROJECT_VIEW_MODES = ("task", "project")
VIEW_DEVICES = ("desktop", "phone")


def get_project_view_modes(user_id: str) -> Dict[str, str]:
    """The saved Projects view per device class; a device never chosen is absent."""
    raw = read_prefs(user_id).get("project_view_mode")
    if not isinstance(raw, dict):
        return {}
    return {
        device: mode
        for device, mode in raw.items()
        if device in VIEW_DEVICES and mode in PROJECT_VIEW_MODES
    }


def set_project_view_mode(user_id: str, device: str, mode: str) -> Dict[str, str]:
    """Save ``mode`` for ``device``; the other device's choice is kept."""
    if device not in VIEW_DEVICES:
        raise ValueError(f"device must be one of {', '.join(VIEW_DEVICES)}")
    if mode not in PROJECT_VIEW_MODES:
        raise ValueError(f"mode must be one of {', '.join(PROJECT_VIEW_MODES)}")
    modes = {**get_project_view_modes(user_id), device: mode}
    _write(user_id, {"project_view_mode": modes})
    return modes


def _write(user_id: str, fields: Dict[str, Any]) -> None:
    path = _prefs_path(user_id)
    doc = read_prefs(user_id)
    doc.update({**fields, "user_id": user_id})
    path.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".prefs-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, indent=2)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
