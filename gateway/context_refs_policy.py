"""Which ``@`` references in a gateway chat message may be expanded (F23).

The gateway turns ``@file:``, ``@folder:``, ``@diff``/``@staged``/``@git:``
and ``@url:`` in the sender's text into attached content before the model
runs. That read happens with no model in the loop, so it must never be more
than the sender could do with their own tools:

* Only a sender that resolved to an enrolled person (``internal_user_id`` +
  ``internal_user_role``) gets expansion. Third-party contacts, unenrolled
  senders, webhooks and Home Assistant events never do.
* Each kind needs the matching tool to be on for the platform and allowed
  for the person's role (``tools/access_policy.py``).
* People whose file tools are confined to their own folder
  (``$HERMES_HOME/workspaces/<user_id>/``) resolve paths inside that folder
  only, and can't use the git kinds (they run in the gateway's own folder).
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import AbstractSet, Dict, FrozenSet, Optional, Tuple

from gateway.config import Platform

# Reference kind -> (platform toolset that must be on, tool the role must keep).
_KIND_REQUIREMENTS: Dict[str, Tuple[str, str]] = {
    "file": ("file", "read_file"),
    "folder": ("file", "search_files"),
    "url": ("web", "web_extract"),
    "diff": ("terminal", "terminal"),
    "staged": ("terminal", "terminal"),
    "git": ("terminal", "terminal"),
}
_GIT_KINDS = frozenset({"diff", "staged", "git"})
_NEVER_EXPAND_PLATFORMS = frozenset({Platform.WEBHOOK, Platform.HOMEASSISTANT})


@dataclass(frozen=True)
class ReferencePolicy:
    allowed_kinds: FrozenSet[str]
    root: Path


def reference_policy(
    source,
    *,
    platform_toolsets: AbstractSet[str],
    default_cwd: str,
) -> Optional[ReferencePolicy]:
    """What *source*'s own text may expand, or ``None`` for nothing at all."""
    if source is None or getattr(source, "platform", None) in _NEVER_EXPAND_PLATFORMS:
        return None
    user_id = getattr(source, "internal_user_id", None)
    role = getattr(source, "internal_user_role", None)
    from hermes_cli.access import ROLES

    if not user_id or role not in ROLES:
        return None

    from tools import access_policy

    denied = access_policy.denied_tools(user_id, role)
    kinds = {
        kind
        for kind, (toolset, tool) in _KIND_REQUIREMENTS.items()
        if toolset in platform_toolsets and tool not in denied
    }
    own_folder = access_policy.files_root(user_id, role)
    if own_folder is not None:
        kinds -= _GIT_KINDS
        root = own_folder
    else:
        root = Path(default_cwd).expanduser()
    return ReferencePolicy(allowed_kinds=frozenset(kinds), root=root.resolve())
