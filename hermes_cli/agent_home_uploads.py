"""agent-home upload size limit (Settings → Uploads).

Stored in the default profile's config.yaml as
``agent_home.uploads.max_bytes``; 1 GB when unset or hand-edited to
something invalid. agent-home enforces it on every upload route and in the
composer's pre-check; owner/admin change it through
``PUT /api/agent-home/uploads``.
"""

from __future__ import annotations

from typing import Any, Dict

DEFAULT_MAX_BYTES = 1024**3
MIN_MAX_BYTES = 1024**2
MAX_MAX_BYTES = 1024**4


def _section(config: Dict[str, Any]) -> Dict[str, Any]:
    agent_home = config.get("agent_home")
    uploads = agent_home.get("uploads") if isinstance(agent_home, dict) else None
    return uploads if isinstance(uploads, dict) else {}


def _valid(value: Any) -> bool:
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and MIN_MAX_BYTES <= value <= MAX_MAX_BYTES
    )


def upload_max_bytes(config: Dict[str, Any]) -> int:
    value = _section(config).get("max_bytes")
    return value if _valid(value) else DEFAULT_MAX_BYTES


def set_upload_max_bytes(config: Dict[str, Any], value: Any) -> int:
    """Store *value* in *config*; ``ValueError`` when out of range."""
    if not _valid(value):
        raise ValueError(
            f"max_bytes must be a whole number between {MIN_MAX_BYTES} (1 MB) "
            f"and {MAX_MAX_BYTES} (1 TB)."
        )
    agent_home = config.get("agent_home")
    if not isinstance(agent_home, dict):
        agent_home = config["agent_home"] = {}
    uploads = agent_home.get("uploads")
    if not isinstance(uploads, dict):
        uploads = agent_home["uploads"] = {}
    uploads["max_bytes"] = value
    return value


def upload_settings(config: Dict[str, Any]) -> Dict[str, int]:
    return {
        "max_bytes": upload_max_bytes(config),
        "default_max_bytes": DEFAULT_MAX_BYTES,
        "min_max_bytes": MIN_MAX_BYTES,
        "max_max_bytes": MAX_MAX_BYTES,
    }
