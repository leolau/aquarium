"""The box-wide skills library behind agent-home's Skills page and the
Skills panel of each Agent Profile.

Every skill on the box is listed once: built-in and hub skills (one copy per
profile that has them), the shared library (``<hermes root>/skills-shared``,
visible to every profile) and each profile's own skills. ``used_by`` says
which profiles have it and whether it is on there.

Profiles stay independent islands: adding a skill to a profile only writes
that profile's ``skills/`` folder and ``skills.disabled`` list, except when
the caller explicitly asks to copy a profile-only skill into the shared
library. Removing a skill turns it off (``skills.disabled``); the file stays.
Deleting is only allowed for a profile's own skill, in that profile.

Every change clears the skills system-prompt cache so it reaches the next new
chat; a running chat keeps its prompt (prompt caching).
"""

from __future__ import annotations

import shutil
from contextlib import AbstractContextManager
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

Scope = Callable[[Optional[str]], AbstractContextManager]

SOURCE_BUILTIN = "builtin"
SOURCE_HUB = "hub"
SOURCE_SHARED = "shared"
SOURCE_PROFILE = "profile"

COPY_SHARED = "shared"
COPY_ONLY = "only"


class LibraryError(Exception):
    """A refused library change; ``status`` is the HTTP status to answer with."""

    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


def _default_scope(profile: Optional[str]) -> AbstractContextManager:
    from hermes_cli.web_server import _profile_scope

    return _profile_scope(profile)


def _profile_names() -> List[str]:
    from hermes_cli.web_server import _skill_profile_names

    return _skill_profile_names()


def _origins(skills_dir: Path) -> Dict[str, Dict[str, Any]]:
    from hermes_cli.web_server import _skill_origins

    return _skill_origins(skills_dir)


def shared_dir(create: bool = False) -> Optional[Path]:
    """``<hermes root>/skills-shared`` (None when absent and not ``create``)."""
    from hermes_constants import get_default_hermes_root

    path = get_default_hermes_root() / "skills-shared"
    if create:
        path.mkdir(parents=True, exist_ok=True)
    return path if path.is_dir() else None


def scan_dir(skills_dir: Optional[Path]) -> Dict[str, Dict[str, Any]]:
    """Skills directly under ``skills_dir``: name → description, category, path."""
    from agent.skill_utils import EXCLUDED_SKILL_DIRS, iter_skill_index_files
    from tools.skills_tool import (
        MAX_DESCRIPTION_LENGTH,
        MAX_NAME_LENGTH,
        _parse_frontmatter,
        skill_matches_platform,
    )

    found: Dict[str, Dict[str, Any]] = {}
    if skills_dir is None or not skills_dir.is_dir():
        return found
    for skill_md in iter_skill_index_files(skills_dir, "SKILL.md"):
        if any(part in EXCLUDED_SKILL_DIRS for part in skill_md.parts):
            continue
        try:
            frontmatter, body = _parse_frontmatter(skill_md.read_text(encoding="utf-8")[:4000])
        except Exception:
            continue
        if not skill_matches_platform(frontmatter):
            continue
        name = str(frontmatter.get("name") or skill_md.parent.name)[:MAX_NAME_LENGTH]
        if name in found:
            continue
        description = str(frontmatter.get("description") or "")
        if not description:
            description = next(
                (ln.strip() for ln in body.splitlines() if ln.strip() and not ln.strip().startswith("#")),
                "",
            )
        if len(description) > MAX_DESCRIPTION_LENGTH:
            description = description[: MAX_DESCRIPTION_LENGTH - 3] + "..."
        rel = skill_md.relative_to(skills_dir).parts
        found[name] = {
            "description": description,
            "category": rel[0] if len(rel) >= 3 else "",
            "path": skill_md.parent,
        }
    return found


def _profile_state(profile: str, scope: Scope) -> Tuple[Path, Dict[str, Dict[str, Any]], set]:
    """(own skills dir, origins, disabled names) for one profile."""
    from hermes_cli.config import load_config
    from hermes_cli.skills_config import get_disabled_skills
    from tools import skills_tool

    with scope(profile):
        own_dir = Path(skills_tool.SKILLS_DIR)
        return own_dir, _origins(own_dir), set(get_disabled_skills(load_config()))


def build_library(scope: Scope = _default_scope) -> Dict[str, Any]:
    """``{"profiles": [...], "skills": [...]}`` for the whole box."""
    shared = scan_dir(shared_dir())
    entries: Dict[str, Dict[str, Any]] = {}
    profiles = _profile_names()
    for profile in profiles:
        try:
            own_dir, origins, disabled = _profile_state(profile, scope)
        except Exception:
            continue
        own = scan_dir(own_dir)
        for name, info in own.items():
            origin = origins.get(name) or {}
            source = origin.get("source") if origin.get("source") in (SOURCE_BUILTIN, SOURCE_HUB) else SOURCE_PROFILE
            entry = entries.get(name)
            if entry is None or (entry["source"] == SOURCE_SHARED):
                prior_used = entry["used_by"] if entry else []
                entry = entries[name] = {
                    "name": name,
                    "description": info["description"],
                    "category": info["category"],
                    "source": source,
                    "owners": [],
                    "used_by": prior_used,
                }
                if origin.get("trust_level"):
                    entry["trust_level"] = origin["trust_level"]
            if source == SOURCE_PROFILE:
                entry["owners"].append(profile)
            entry["used_by"].append({"profile": profile, "enabled": name not in disabled})
        for name, info in shared.items():
            if name in own:
                continue
            entry = entries.setdefault(
                name,
                {
                    "name": name,
                    "description": info["description"],
                    "category": info["category"],
                    "source": SOURCE_SHARED,
                    "owners": [],
                    "used_by": [],
                },
            )
            entry["used_by"].append({"profile": profile, "enabled": name not in disabled})
    for name, info in shared.items():
        entries.setdefault(
            name,
            {
                "name": name,
                "description": info["description"],
                "category": info["category"],
                "source": SOURCE_SHARED,
                "owners": [],
                "used_by": [],
            },
        )
    for entry in entries.values():
        entry["in_shared"] = entry["name"] in shared
    skills = sorted(entries.values(), key=lambda e: e["name"])
    return {"profiles": profiles, "skills": skills}


def _require_profile(profile: str) -> None:
    if not isinstance(profile, str) or profile not in _profile_names():
        raise LibraryError(404, f"Profile '{profile}' does not exist.")


def _visible_in(profile: str, name: str, scope: Scope) -> Optional[Path]:
    """Where ``profile`` finds ``name`` (own folder, then the shared library)."""
    own_dir, _, _ = _profile_state(profile, scope)
    hit = scan_dir(own_dir).get(name) or scan_dir(shared_dir()).get(name)
    return hit["path"] if hit else None


def _set_enabled(profile: str, name: str, enabled: bool, scope: Scope) -> None:
    from hermes_cli.config import load_config
    from hermes_cli.skills_config import get_disabled_skills, save_disabled_skills

    with scope(profile):
        config = load_config()
        disabled = set(get_disabled_skills(config))
        if enabled == (name not in disabled):
            return
        if enabled:
            disabled.discard(name)
        else:
            disabled.add(name)
        save_disabled_skills(config, disabled)


def _target_folder(base: Path, src: Path, src_root: Path) -> Path:
    """Keep the source's category folder (``<category>/<name>``) under ``base``."""
    try:
        rel = src.relative_to(src_root)
    except ValueError:
        rel = Path(src.name)
    dest = (base / rel).resolve()
    if base.resolve() not in dest.parents:
        raise LibraryError(400, "Refusing to write outside the skills folder.")
    return dest


def _copy_origin_records(name: str, src_dir: Path, dest_dir: Path) -> None:
    """Carry the bundled-manifest / hub-lock line over so the copy keeps its source."""
    try:
        for line in (src_dir / ".bundled_manifest").read_text(encoding="utf-8").splitlines():
            if line.partition(":")[0].strip() == name:
                manifest = dest_dir / ".bundled_manifest"
                existing = manifest.read_text(encoding="utf-8") if manifest.exists() else ""
                if not any(ln.partition(":")[0].strip() == name for ln in existing.splitlines()):
                    if existing and not existing.endswith("\n"):
                        existing += "\n"
                    manifest.write_text(existing + line + "\n", encoding="utf-8")
                break
    except OSError:
        pass
    try:
        from tools.skills_hub import HubLockFile

        entry = HubLockFile(src_dir / ".hub" / "lock.json").get_installed(name)
        if entry:
            lock = HubLockFile(dest_dir / ".hub" / "lock.json")
            data = lock.load()
            data.setdefault("installed", {})[name] = entry
            lock.save(data)
    except Exception:
        pass


def add_to_profile(
    target: str, name: str, copy: Optional[str] = None, scope: Scope = _default_scope
) -> Dict[str, Any]:
    """Turn ``name`` on for ``target``, copying it in first when it has no copy.

    A profile-only skill that lives in other profiles needs ``copy``:
    ``"shared"`` moves it into the shared library (every profile can then see
    it; its owners keep their on/off state), ``"only"`` copies it into
    ``target``'s own folder.
    """
    _require_profile(target)
    library = {s["name"]: s for s in build_library(scope)["skills"]}
    entry = library.get(name)
    if entry is None:
        raise LibraryError(404, f"Skill '{name}' is not in the library.")
    result: Dict[str, Any] = {"ok": True, "profile": target, "name": name, "copied": None}
    if _visible_in(target, name, scope) is None:
        donors = entry["owners"] if entry["source"] == SOURCE_PROFILE else [
            u["profile"] for u in entry["used_by"]
        ]
        donors = [d for d in donors if d != target]
        if not donors:
            raise LibraryError(404, f"Skill '{name}' has no copy to add from.")
        donor = donors[0]
        donor_dir, _, _ = _profile_state(donor, scope)
        src = _visible_in(donor, name, scope)
        if src is None:
            raise LibraryError(404, f"Skill '{name}' has no copy to add from.")
        target_dir, _, _ = _profile_state(target, scope)
        if entry["source"] == SOURCE_PROFILE:
            if copy not in (COPY_SHARED, COPY_ONLY):
                raise LibraryError(
                    409,
                    f"'{name}' only exists in profile '{donor}': choose where='shared' "
                    "(into the shared library) or where='only' (into this profile).",
                )
            if copy == COPY_SHARED:
                lib_root = shared_dir(create=True)
                assert lib_root is not None
                dest = _target_folder(lib_root, src, donor_dir)
                if dest.exists():
                    raise LibraryError(409, f"The shared library already has '{name}'.")
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copytree(src, dest)
                # Moved, not duplicated: the donor now reads the shared copy
                # (its own copy would shadow it).
                shutil.rmtree(src)
                result["copied"] = COPY_SHARED
                result["moved_from"] = donor
            else:
                dest = _target_folder(target_dir, src, donor_dir)
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copytree(src, dest)
                result["copied"] = COPY_ONLY
        else:
            dest = _target_folder(target_dir, src, donor_dir)
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(src, dest)
            _copy_origin_records(name, donor_dir, target_dir)
            result["copied"] = COPY_ONLY
            result["copied_from"] = donor
    _set_enabled(target, name, True, scope)
    _changed()
    return result


def remove_from_profile(target: str, name: str, scope: Scope = _default_scope) -> Dict[str, Any]:
    """Turn ``name`` off for ``target`` (``skills.disabled``); the file stays."""
    _require_profile(target)
    if _visible_in(target, name, scope) is None:
        raise LibraryError(404, f"Profile '{target}' has no skill '{name}'.")
    _set_enabled(target, name, False, scope)
    _changed()
    return {"ok": True, "profile": target, "name": name, "enabled": False}


def delete_from_profile(target: str, name: str, scope: Scope = _default_scope) -> Dict[str, Any]:
    """Delete ``target``'s own copy of a profile-only skill (never built-in,
    hub or shared skills: those can only be removed)."""
    _require_profile(target)
    own_dir, origins, _ = _profile_state(target, scope)
    own = scan_dir(own_dir).get(name)
    if own is None:
        raise LibraryError(404, f"Profile '{target}' has no skill '{name}' of its own.")
    source = (origins.get(name) or {}).get("source")
    if source in (SOURCE_BUILTIN, SOURCE_HUB):
        raise LibraryError(409, f"'{name}' is a {source} skill: remove it instead of deleting it.")
    path = Path(own["path"]).resolve()
    if own_dir.resolve() not in path.parents:
        raise LibraryError(400, "Refusing to delete outside the profile's skills folder.")
    shutil.rmtree(path)
    parent = path.parent
    if parent != own_dir.resolve() and parent.is_dir() and not any(parent.iterdir()):
        parent.rmdir()
    from hermes_cli.config import load_config
    from hermes_cli.skills_config import get_disabled_skills, save_disabled_skills

    if _visible_in(target, name, scope) is None:
        with scope(target):
            config = load_config()
            disabled = set(get_disabled_skills(config))
            if name in disabled:
                disabled.discard(name)
                save_disabled_skills(config, disabled)
    _changed()
    return {"ok": True, "profile": target, "name": name, "deleted": True}


def _changed() -> None:
    """New chats pick the change up; running chats keep their cached prompt."""
    try:
        from agent.skill_utils import _external_dirs_cache_clear

        _external_dirs_cache_clear()
    except Exception:
        pass
    from hermes_cli.web_server import _clear_skills_prompt_cache

    _clear_skills_prompt_cache()
