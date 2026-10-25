"""FG-33 §10 coder profiles (P8-2 item 2.9, decision 15).

Two Hermes profiles build vibe-coded apps as kanban workers:
``internal-coder`` for local apps and ``external-coder`` for external ones.
Their versioned definitions live in ``deploy/profiles/<name>/`` (``SOUL.md``,
a ``config.yaml`` overlay and ``profile.yaml`` with the skill list) and are
installed by an ops step (see ``deploy/profiles/internal-coder/README.md``)::

    python -m hermes_cli.app_coder install           # both profiles
    python -m hermes_cli.app_coder check             # validate definitions

* :func:`coder_profile_for` picks a tool's kanban assignee: the tool's own
  ``coder_profile`` override, otherwise the hosting default.
* :func:`set_coder_profile` sets or clears that override (the
  ``hermes tool set <slug> --coder-profile <name>`` verb, wired by item 2.4).

A coder profile never holds a credential: definitions are refused when they
carry a secret-looking key, and installation is refused when the target
profile's ``.env`` holds a hosting-provider credential (those stay
``materialize=False`` behind the adapters, §4.2).
"""

from __future__ import annotations

import argparse
import copy
import re
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping, Optional, Sequence, Tuple

import yaml

from hermes_cli.access import Principal

INTERNAL_CODER = "internal-coder"
EXTERNAL_CODER = "external-coder"
CODER_PROFILES: Tuple[str, ...] = (INTERNAL_CODER, EXTERNAL_CODER)

#: The only files a definition may contain (README.md is docs, never copied).
DEFINITION_FILES = frozenset({"profile.yaml", "config.yaml", "SOUL.md", "README.md"})

#: Marker written into an installed profile (definition name + version).
INSTALLED_MARKER = "coder-profile.yaml"

_REPO_ROOT = Path(__file__).resolve().parents[1]

#: Config keys that would hold a secret. Definitions must have none.
_SECRET_KEY = re.compile(
    r"(api[_-]?key|token|secret|password|passwd|credential|private[_-]?key|"
    r"access[_-]?key|auth[_-]?header|bearer|dsn)",
    re.IGNORECASE,
)
#: Hosting-provider (and source-host) credential names a coder must not hold.
_PROVIDER_ENV = re.compile(
    r"^(VERCEL|RAILWAY|AWS|AMPLIFY|ALIBABA|ALIBABA_CLOUD|ALICLOUD|ALIYUN|"
    r"SUPABASE|NETLIFY|CLOUDFLARE|CF|FLY|RENDER|HEROKU|GH|GITHUB)_[A-Z0-9_]*$"
)
#: Overlay keys a kanban-only worker must not set (no channel, no gateway).
_FORBIDDEN_OVERLAY_KEYS = frozenset({"platforms", "gateway", "mcp_servers"})


class CoderProfileError(ValueError):
    """A coder profile definition or installation is unsafe or invalid."""


# ── assignment ───────────────────────────────────────────────────────────────


def _field(tool_row: Any, name: str) -> Any:
    if isinstance(tool_row, Mapping):
        return tool_row.get(name)
    return getattr(tool_row, name, None)


def default_coder_profile(hosting: Optional[str], kind: Optional[str] = None) -> str:
    """The hosting default: external apps get ``external-coder``."""
    if hosting == "external" or (hosting is None and kind == "external"):
        return EXTERNAL_CODER
    return INTERNAL_CODER


def coder_profile_for(tool_row: Any) -> str:
    """Return the kanban assignee for building ``tool_row``.

    ``tool_row`` is a ``tools_registry.Tool`` or a row mapping. The tool's
    ``coder_profile`` wins when it is a valid profile name; otherwise the
    hosting default (decision 15).
    """
    from hermes_cli.profiles import normalize_profile_name, validate_profile_name

    override = _field(tool_row, "coder_profile")
    if isinstance(override, str) and override.strip():
        name = normalize_profile_name(override)
        try:
            validate_profile_name(name)
        except ValueError:
            pass
        else:
            return name
    return default_coder_profile(_field(tool_row, "hosting"), _field(tool_row, "kind"))


def _can_set(principal: Principal, tool: Any) -> bool:
    """§10: owner/admin for shared tools; the author too for private ones."""
    if principal.role == "viewer" or not principal.active:
        return False
    if principal.is_owner or principal.role == "admin":
        return True
    return tool.visibility != "shared" and tool.owner_user_id == principal.user_id


def _normalize_override(profile: Optional[str]) -> Optional[str]:
    from hermes_cli.profiles import normalize_profile_name, profile_exists, validate_profile_name

    if profile is None or not str(profile).strip():
        return None
    name = normalize_profile_name(str(profile))
    validate_profile_name(name)
    if not profile_exists(name):
        raise ValueError(
            f"No profile named {name!r} on this box: create it first "
            f"(python -m hermes_cli.app_coder install, or hermes profile create)."
        )
    return name


async def set_coder_profile(
    name: str,
    profile: Optional[str],
    *,
    principal: Optional[Principal] = None,
    mode: Optional[str] = None,
    registry: Any = None,
    prod_store: Any = None,
) -> Any:
    """Set (or, with ``None``/``""``, clear) tool ``name``'s coder profile.

    The override can only name an existing profile and is recorded as a C5
    change. Returns the updated ``Tool``. Raises ``KeyError`` (no such tool),
    ``PermissionError`` (not allowed) or ``ValueError`` (bad profile).
    ``principal``/``registry`` default to ``hermes tool``'s own resolution
    (mode ``dev``, where apps are authored).
    """
    from hermes_cli.datastore import get_store
    from hermes_cli.tools_registry import TOOLS_TABLE, ToolRegistry, _COLUMNS, _row_to_tool

    override = _normalize_override(profile)
    if prod_store is None:
        prod_store = get_store("supabase-app", "prod")
    if principal is None:
        from hermes_cli.tool_cmd import _resolve_operator

        principal = await _resolve_operator(prod_store, None)
    if registry is None:
        registry = ToolRegistry(get_store("supabase-app", mode or "dev"))
        await registry.initialize()

    tool = await registry.get(name)
    if tool is None:
        raise KeyError(f"No such tool: {name}")
    if not _can_set(principal, tool):
        raise PermissionError(
            f"{principal.user_id} may not change the coder profile of {name!r}"
            + (" (shared tools: owner/admin only)" if tool.visibility == "shared" else "")
        )
    before = tool.coder_profile
    conn = await registry.store.connect()
    try:
        row = await conn.fetchrow(
            f"""
            UPDATE {TOOLS_TABLE}
            SET coder_profile = $2, updated_at = NOW()
            WHERE name = $1
            RETURNING {_COLUMNS}
            """,
            name,
            override,
        )
    finally:
        await conn.close()
    if row is None:  # pragma: no cover - deleted between read and write
        raise KeyError(f"No such tool: {name}")
    updated = _row_to_tool(row)
    await _record_change(
        prod_store, principal, updated, mode=registry.mode, before=before, after=override,
    )
    return updated


async def _record_change(
    prod_store: Any, principal: Principal, tool: Any, *, mode: str,
    before: Optional[str], after: Optional[str],
) -> None:
    """A pre-approved C5 change; best-effort like ``tool_cmd._record_provenance``."""
    from hermes_cli.changes import ChangeLog, initialize_changes

    payload = {
        "coder_profile": after,
        "previous": before,
        "resolved": coder_profile_for(tool),
    }
    op = [{"op": "record", "path": f"/tools/{tool.name}/coder_profile", "value": after}]
    inverse = [{"op": "record", "path": f"/tools/{tool.name}/coder_profile", "value": before}]
    try:
        conn = await prod_store.connect()
        try:
            await initialize_changes(conn)
        finally:
            await conn.close()
        await ChangeLog(prod_store).record(
            actor_user_id=principal.user_id, target_kind="code", op=op,
            inverse_op=inverse, reversible=True, action="tool.set_coder_profile",
            target_ref=tool.name, mode=mode, visibility=tool.visibility,
            payload=payload, approved=True,
        )
    except Exception as exc:  # noqa: BLE001 - provenance is best-effort
        print(f"warning: could not record provenance change: {exc}")


# ── versioned definitions ────────────────────────────────────────────────────


@dataclass(frozen=True)
class CoderDefinition:
    name: str
    version: str
    description: str
    soul: str
    overlay: dict
    skills: Tuple[str, ...]
    path: Path


def definitions_root() -> Path:
    return _REPO_ROOT / "deploy" / "profiles"


def _secret_paths(node: Any, prefix: str = "") -> list[str]:
    found: list[str] = []
    if isinstance(node, Mapping):
        for key, value in node.items():
            path = f"{prefix}.{key}" if prefix else str(key)
            if _SECRET_KEY.search(str(key)) and value not in (None, "", [], {}):
                found.append(path)
            found.extend(_secret_paths(value, path))
    elif isinstance(node, list):
        for index, value in enumerate(node):
            found.extend(_secret_paths(value, f"{prefix}[{index}]"))
    elif isinstance(node, str) and _PROVIDER_ENV.match(node.split("=", 1)[0].strip()) and "=" in node:
        found.append(prefix)
    return found


def _check_skill_path(skill: Any) -> str:
    if not isinstance(skill, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]*(/[a-z0-9][a-z0-9_-]*)*", skill):
        raise CoderProfileError(f"Invalid skill path in definition: {skill!r}")
    return skill


def load_definition(name: str, *, root: Optional[Path] = None) -> CoderDefinition:
    """Load and validate ``deploy/profiles/<name>``; refuse anything unsafe."""
    from hermes_cli.profiles import validate_profile_name

    validate_profile_name(name)
    base = (root or definitions_root()) / name
    if not base.is_dir():
        raise CoderProfileError(f"No coder profile definition at {base}")
    extra = sorted(
        str(p.relative_to(base)) for p in base.rglob("*")
        if p.is_symlink() or not p.is_file() or p.name not in DEFINITION_FILES
        or p.parent != base
    )
    if extra:
        raise CoderProfileError(
            f"{name}: unexpected files in definition (only "
            f"{', '.join(sorted(DEFINITION_FILES))}): {', '.join(extra)}"
        )
    for required in ("profile.yaml", "config.yaml", "SOUL.md"):
        if not (base / required).is_file():
            raise CoderProfileError(f"{name}: missing {required}")

    meta = yaml.safe_load((base / "profile.yaml").read_text(encoding="utf-8")) or {}
    overlay = yaml.safe_load((base / "config.yaml").read_text(encoding="utf-8")) or {}
    if not isinstance(meta, dict) or not isinstance(overlay, dict):
        raise CoderProfileError(f"{name}: profile.yaml and config.yaml must be mappings")
    if meta.get("name") != name:
        raise CoderProfileError(f"{name}: profile.yaml name is {meta.get('name')!r}")
    version = str(meta.get("version") or "").strip()
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise CoderProfileError(f"{name}: profile.yaml needs a semver version")
    secrets = _secret_paths(meta) + _secret_paths(overlay)
    if secrets:
        raise CoderProfileError(
            f"{name}: credentials never go in a coder profile ({', '.join(secrets)})"
        )
    forbidden = sorted(_FORBIDDEN_OVERLAY_KEYS & set(overlay))
    if forbidden:
        raise CoderProfileError(
            f"{name}: a coder profile runs only as a kanban worker; "
            f"remove {', '.join(forbidden)} from config.yaml"
        )
    skills = meta.get("skills") or []
    if not isinstance(skills, list):
        raise CoderProfileError(f"{name}: skills must be a list")
    soul = (base / "SOUL.md").read_text(encoding="utf-8")
    if not soul.strip():
        raise CoderProfileError(f"{name}: SOUL.md is empty")
    return CoderDefinition(
        name=name,
        version=version,
        description=str(meta.get("description") or "").strip(),
        soul=soul,
        overlay=overlay,
        skills=tuple(_check_skill_path(s) for s in skills),
        path=base,
    )


def _deep_merge(base: dict, overlay: Mapping[str, Any]) -> dict:
    out = copy.deepcopy(base)
    for key, value in overlay.items():
        if isinstance(value, Mapping) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = copy.deepcopy(value)
    return out


def provider_credentials_in(profile_dir: Path) -> list[str]:
    """Names of hosting-provider credentials in ``profile_dir/.env`` (never values)."""
    env = profile_dir / ".env"
    if not env.is_file():
        return []
    names = []
    for line in env.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key = line.split("=", 1)[0].removeprefix("export ").strip()
        if _PROVIDER_ENV.match(key):
            names.append(key)
    return names


def install_coder_profile(
    name: str,
    *,
    root: Optional[Path] = None,
    skills_source: Optional[Path] = None,
    report: Callable[[str], None] = print,
) -> Path:
    """Create (if needed) and update profile ``name`` from its definition.

    Equivalent to ``hermes profile create <name> --no-alias`` plus the
    overlay: ``config.yaml`` is deep-merged (overlay keys win), ``SOUL.md`` is
    replaced and the listed repo skills are copied. ``.env``, ``auth.json``,
    memories and sessions are never touched. Idempotent.
    """
    from hermes_cli.profiles import create_profile, get_profile_dir, profile_exists

    definition = load_definition(name, root=root)
    if not profile_exists(name):
        create_profile(
            name, no_alias=True, no_skills=True,
            description=definition.description or None, report=report,
        )
    profile_dir = get_profile_dir(name)
    held = provider_credentials_in(profile_dir)
    if held:
        raise CoderProfileError(
            f"{name}: remove provider credentials from {profile_dir / '.env'} "
            f"({', '.join(held)}); coder profiles never hold them"
        )

    config_path = profile_dir / "config.yaml"
    current: dict = {}
    if config_path.is_file():
        current = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
        if not isinstance(current, dict):
            current = {}
    merged = _deep_merge(current, definition.overlay)
    config_path.write_text(yaml.safe_dump(merged, sort_keys=False), encoding="utf-8")
    (profile_dir / "SOUL.md").write_text(definition.soul, encoding="utf-8")

    source = skills_source or (_REPO_ROOT / "skills")
    installed, missing = [], []
    for skill in definition.skills:
        src = source / skill
        if not (src / "SKILL.md").is_file():
            missing.append(skill)
            continue
        dest = profile_dir / "skills" / skill
        if dest.exists():
            shutil.rmtree(dest)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(src, dest, ignore=shutil.ignore_patterns(".env", "*.pem", "auth.json"))
        installed.append(skill)
    (profile_dir / INSTALLED_MARKER).write_text(
        yaml.safe_dump(
            {"name": name, "version": definition.version, "skills": installed},
            sort_keys=False,
        ),
        encoding="utf-8",
    )
    report(f"{name} {definition.version}: {len(installed)} skills at {profile_dir}")
    if missing:
        report(f"{name}: skills not in this checkout yet: {', '.join(missing)}")
    return profile_dir


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m hermes_cli.app_coder",
        description="Install or check the FG-33 coder profiles.",
    )
    sub = parser.add_subparsers(dest="action", required=True)
    for action in ("install", "check"):
        p = sub.add_parser(action)
        p.add_argument("names", nargs="*", metavar="|".join(CODER_PROFILES))
    args = parser.parse_args(argv)
    names = list(args.names) or list(CODER_PROFILES)
    unknown = sorted(set(names) - set(CODER_PROFILES))
    if unknown:
        parser.error(f"unknown coder profile(s): {', '.join(unknown)}")
    try:
        for name in names:
            if args.action == "check":
                d = load_definition(name)
                print(f"{name} {d.version}: ok ({len(d.skills)} skills)")
            else:
                install_coder_profile(name)
    except (CoderProfileError, ValueError, FileExistsError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


__all__ = [
    "CODER_PROFILES",
    "EXTERNAL_CODER",
    "INTERNAL_CODER",
    "CoderDefinition",
    "CoderProfileError",
    "coder_profile_for",
    "default_coder_profile",
    "definitions_root",
    "install_coder_profile",
    "load_definition",
    "provider_credentials_in",
    "set_coder_profile",
]


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
