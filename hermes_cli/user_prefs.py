"""Per-person interface preferences (today: the agent-home language).

One small JSON file per login under ``$HERMES_HOME/auth/user_prefs/``, named
by a hash of the principal's ``user_id`` so an id can never become a path.
Files are 0600 in a 0700 directory, written atomically. Nothing here is a
secret; it lives under ``auth/`` because that is where per-login runtime
state already goes (the checkout may be root-owned).

A person only ever reads or writes their own file: the web routes pass the
acting principal's ``user_id`` and never take one from the request.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path
from typing import Any, Dict, Optional

from hermes_constants import get_hermes_home

#: Languages agent-home ships strings for. ``en`` is the default.
SUPPORTED_LANGUAGES = ("en", "zh-Hant")


def _prefs_dir() -> Path:
    return get_hermes_home() / "auth" / "user_prefs"


def _prefs_path(user_id: str) -> Path:
    if not isinstance(user_id, str) or not user_id.strip():
        raise ValueError("user_id is required")
    digest = hashlib.sha256(user_id.encode("utf-8")).hexdigest()[:40]
    return _prefs_dir() / f"{digest}.json"


def read_prefs(user_id: str) -> Dict[str, Any]:
    """This person's saved preferences, ``{}`` when none are saved."""
    path = _prefs_path(user_id)
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(doc, dict) or doc.get("user_id") != user_id:
        return {}
    return doc


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
    path = _prefs_path(user_id)
    doc = read_prefs(user_id)
    doc.update({"user_id": user_id, "language": language})
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
    return language
