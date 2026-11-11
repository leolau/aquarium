"""Secrets by name (FG-37 W2): ``list_secrets`` and ``secret_env`` resolution.

Secrets live in the per-user credential store under provider ``secret``
(kind ``secret``: ``value`` [+ ``username``]; kind ``password``: ``username``
+ ``password``). The model only ever sees names; values are resolved here,
in-process, for the principal bound to the current tool call and handed to
the terminal as one command's environment.
"""

from __future__ import annotations

import base64
import json
import re
from typing import Any, Dict, List, Mapping

from tools.registry import registry

PROVIDER = "secret"
KINDS = ("secret", "password")

_ENV_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
# Names that change how bash or the dynamic loader behave, plus our carriers.
_RESERVED_ENV = frozenset({
    "PATH", "HOME", "SHELL", "IFS", "ENV", "BASH_ENV", "PS4", "SHELLOPTS",
    "BASHOPTS", "PROMPT_COMMAND", "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT",
})
_SECRET_FIELD = {"secret": "value", "password": "password"}


class SecretEnvError(ValueError):
    """A ``secret_env`` mapping cannot be satisfied; the message holds no value."""


def _principal():
    from hermes_cli.access import Principal, normalize_role
    from tools.access_policy import current_principal

    user_id, role = current_principal()
    if not user_id:
        raise SecretEnvError("no signed-in person is bound to this request")
    return Principal(user_id=user_id, display=user_id, role=normalize_role(role))


async def own_secrets(principal: Any) -> list:
    """The caller's OWN secret entries — never another person's, owner included."""
    from hermes_cli.credential_store import default_credential_store

    entries = await default_credential_store().list(principal)
    return [
        e for e in entries
        if e.provider == PROVIDER
        and e.kind in KINDS
        and e.owner_user_id == principal.user_id
    ]


def _view(entry: Any) -> Dict[str, Any]:
    view: Dict[str, Any] = {"name": entry.name, "kind": entry.kind}
    username = (entry.payload or {}).get("username")
    if username:
        view["username"] = str(username)
    view["updated_at"] = entry.updated_at.isoformat() if entry.updated_at else None
    return view


def _field_of(entry: Any, ref: str, field: str) -> str:
    payload = entry.payload or {}
    if field in ("value", "password", ""):
        key = _SECRET_FIELD[entry.kind]
    elif field == "username":
        key = "username"
    else:
        raise SecretEnvError(
            f"secret reference {ref!r}: field must be .value, .password or .username"
        )
    value = payload.get(key)
    if not isinstance(value, str) or not value:
        raise SecretEnvError(f"secret {entry.name!r} has no {key}")
    return value


def resolve_secret_env(mapping: Mapping[str, Any]) -> Dict[str, str]:
    """``{"ENV_VAR": "name[.field]"}`` -> ``{"ENV_VAR": value}`` for the caller."""
    if not isinstance(mapping, Mapping):
        raise SecretEnvError('secret_env must be an object like {"ENV_VAR": "secret-name"}')
    refs: Dict[str, tuple] = {}
    for env_name, ref in mapping.items():
        if not isinstance(env_name, str) or not _ENV_NAME_RE.match(env_name):
            raise SecretEnvError(f"secret_env: {env_name!r} is not a valid variable name")
        if env_name in _RESERVED_ENV or env_name.startswith("HERMES_"):
            raise SecretEnvError(f"secret_env: {env_name} cannot carry a secret")
        if not isinstance(ref, str) or not ref.strip():
            raise SecretEnvError(f"secret_env[{env_name}] must name a secret")
        # Names may contain dots, so only a trailing known field splits.
        stripped = ref.strip()
        for suffix in ("value", "password", "username"):
            if stripped.endswith("." + suffix):
                name, field = stripped[: -len(suffix) - 1], suffix
                break
        else:
            name, field = stripped, ""
        refs[env_name] = (stripped, name, field)
    if not refs:
        return {}

    from model_tools import _run_async

    entries = {e.name: e for e in _run_async(own_secrets(_principal()))}
    resolved: Dict[str, str] = {}
    for env_name, (ref, name, field) in refs.items():
        entry = entries.get(name)
        if entry is None:
            raise SecretEnvError(
                f"no secret named {name!r}; call list_secrets to see yours, "
                "or request_secret to ask the person for it"
            )
        resolved[env_name] = _field_of(entry, ref, field)
    return resolved


def secret_masks(values) -> List[str]:
    """Each value plus cheap encodings of it (base64, JSON-escaped) to mask."""
    masks = set()
    for value in values:
        if not value:
            continue
        masks.add(value)
        masks.add(json.dumps(value, ensure_ascii=False)[1:-1])
        masks.add(json.dumps(value)[1:-1])
        raw = value.encode()
        if len(raw) >= 4:
            for encoded in (base64.b64encode(raw), base64.urlsafe_b64encode(raw)):
                text = encoded.decode()
                masks.add(text)
                masks.add(text.rstrip("="))
    return sorted(masks, key=len, reverse=True)


LIST_SECRETS_SCHEMA = {
    "name": "list_secrets",
    "description": (
        "List the person's stored secrets by name (kind, username, updated_at). "
        "Never returns values. Use a name with terminal secret_env to consume it."
    ),
    "parameters": {"type": "object", "properties": {}, "required": []},
}


async def list_secrets_tool(args: Dict[str, Any], **_kw: Any) -> str:
    try:
        entries = await own_secrets(_principal())
    except SecretEnvError as exc:
        return json.dumps({"success": False, "error": str(exc)}, ensure_ascii=False)
    secrets = sorted((_view(e) for e in entries), key=lambda v: v["name"])
    return json.dumps({"success": True, "secrets": secrets}, ensure_ascii=False)


registry.register(
    name="list_secrets",
    toolset="secrets",
    schema=LIST_SECRETS_SCHEMA,
    handler=list_secrets_tool,
    is_async=True,
    emoji="🔑",
)
