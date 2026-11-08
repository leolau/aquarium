"""Skill version history — snapshots, drafts, diffs and atomic activation.

Every successful write to a live skill folder (dashboard create/edit, the
agent's ``skill_manage`` writes, curator passes, hub installs/updates) is
recorded as a full copy of the folder under::

    $HERMES_HOME/skills/.versions/<skill-name>/<id>/
    $HERMES_HOME/skills/.versions/<skill-name>/index.json

``.versions`` is listed in ``agent.skill_utils.EXCLUDED_SKILL_DIRS`` so the
skill loader, ``skills_list``, the curator, hub sync and the bundled-manifest
sync never see these copies as skills.

``index.json``::

    {"active": "v3",
     "versions": [{"id", "n", "created_at", "author", "message", "parent",
                   "status", "source", "sha256", "trial_of"}, ...],
     "live_path": "<category>/<name>"}   # internal, never sent to clients

Versions are immutable once written. ``activate`` copies a stored version
back over the live folder (stage + rename swap) and clears the skills prompt
cache, so the change applies to the next prompt build: a running
conversation keeps the system prompt it already cached, exactly as with any
other skill edit. Drafts (``create_draft``) never touch the live folder.

Only skills inside the profile's own ``skills/`` directory are versioned;
skills in ``skills.external_dirs`` are left alone.
"""

from __future__ import annotations

import contextvars
import difflib
import hashlib
import json
import logging
import os
import re
import shutil
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional

from hermes_constants import get_skills_dir

logger = logging.getLogger(__name__)

msvcrt = None
try:
    import fcntl
except ImportError:  # pragma: no cover - platform-specific fallback
    fcntl = None
    try:
        import msvcrt
    except ImportError:
        pass


VERSIONS_DIRNAME = ".versions"
INDEX_FILENAME = "index.json"
DEFAULT_MAX_PER_SKILL = 50

#: Folders bigger than this are not snapshotted (logged and skipped) so one
#: oversized skill cannot fill the disk with copies.
MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024

STATUS_ACTIVE = "active"
STATUS_DRAFT = "draft"
STATUS_ARCHIVED = "archived"

SOURCES = frozenset(
    ("create", "edit", "patch", "restore", "improve", "baseline", "import")
)

_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_VERSION_ID_RE = re.compile(r"^v([1-9][0-9]{0,8})$")
_AUTHOR_RE = re.compile(r"^(?:(?:user|agent):[^\x00-\x1f\x7f]{0,200}|curator|hub|system)$")
_SKIP_PARTS = frozenset((".git", "__pycache__", VERSIONS_DIRNAME))
_META_KEYS = (
    "id", "n", "created_at", "author", "message", "parent",
    "status", "source", "sha256", "trial_of",
)
_MAX_MESSAGE_CHARS = 500

_thread_locks: Dict[str, threading.RLock] = {}
_thread_locks_guard = threading.Lock()

_author_override: "contextvars.ContextVar[Optional[str]]" = contextvars.ContextVar(
    "skill_versions_author", default=None
)


class SkillVersionError(ValueError):
    """Invalid input (bad name/id/content) — maps to HTTP 400."""


class SkillVersionNotFound(LookupError):
    """Unknown skill or version — maps to HTTP 404."""


# ---------------------------------------------------------------------------
# Validation / paths
# ---------------------------------------------------------------------------


def validate_name(name: Any) -> str:
    if not isinstance(name, str) or not _NAME_RE.match(name) or ".." in name:
        raise SkillVersionError("Invalid skill name.")
    return name


def validate_version_id(version_id: Any) -> str:
    if not isinstance(version_id, str) or not _VERSION_ID_RE.match(version_id):
        raise SkillVersionError("Invalid version id.")
    return version_id


def _validate_author(author: Any) -> str:
    if not isinstance(author, str) or not _AUTHOR_RE.match(author):
        raise SkillVersionError("Invalid author.")
    return author


def _clean_message(message: Any) -> str:
    text = "" if message is None else str(message)
    text = "".join(ch for ch in text if ch in "\n\t" or ord(ch) >= 32).strip()
    return text[:_MAX_MESSAGE_CHARS]


def _skills_root() -> Path:
    return get_skills_dir()


def _store_root() -> Path:
    return _skills_root() / VERSIONS_DIRNAME


def _store_dir(name: str) -> Path:
    return _store_root() / validate_name(name)


def _index_path(name: str) -> Path:
    return _store_dir(name) / INDEX_FILENAME


def max_per_skill() -> int:
    """``skills.versions.max_per_skill`` from config.yaml (default 50)."""
    try:
        from agent.skill_utils import _load_raw_config

        cfg = _load_raw_config().get("skills") or {}
        value = int(((cfg.get("versions") or {}).get("max_per_skill")) or DEFAULT_MAX_PER_SKILL)
    except Exception:
        value = DEFAULT_MAX_PER_SKILL
    return max(1, value)


# ---------------------------------------------------------------------------
# Locking
# ---------------------------------------------------------------------------


_held_locks = threading.local()


@contextmanager
def _skill_lock(name: str) -> Iterator[None]:
    """Serialise index read-modify-write cycles for one skill (threads + processes)."""
    store = _store_dir(name)
    key = str(store)
    with _thread_locks_guard:
        tlock = _thread_locks.setdefault(key, threading.RLock())
    held = _held_locks.__dict__.setdefault("keys", set())
    if key in held:
        yield
        return
    with tlock:
        held.add(key)
        try:
            with _process_lock(store):
                yield
        finally:
            held.discard(key)


@contextmanager
def _process_lock(store: Path) -> Iterator[None]:
    store.mkdir(parents=True, exist_ok=True)
    lock_path = store / ".lock"
    if fcntl is None and msvcrt is None:
        yield
        return
    if msvcrt and (not lock_path.exists() or lock_path.stat().st_size == 0):
        lock_path.write_text(" ", encoding="utf-8")
    fd = open(lock_path, "r+" if msvcrt else "a+", encoding="utf-8")
    try:
        if fcntl:
            fcntl.flock(fd, fcntl.LOCK_EX)
        else:
            fd.seek(0)
            msvcrt.locking(fd.fileno(), msvcrt.LK_LOCK, 1)
        yield
    finally:
        try:
            if fcntl:
                fcntl.flock(fd, fcntl.LOCK_UN)
            elif msvcrt:
                fd.seek(0)
                msvcrt.locking(fd.fileno(), msvcrt.LK_UNLCK, 1)
        except OSError:
            pass
        fd.close()


# ---------------------------------------------------------------------------
# Index I/O
# ---------------------------------------------------------------------------


def _empty_index() -> Dict[str, Any]:
    return {"active": None, "versions": []}


def _read_index(name: str) -> Dict[str, Any]:
    path = _index_path(name)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return _empty_index()
    except (OSError, ValueError) as exc:
        logger.warning("skill versions: unreadable index for %s: %s", name, exc)
        return _empty_index()
    if not isinstance(data, dict) or not isinstance(data.get("versions"), list):
        return _empty_index()
    data["versions"] = [
        v for v in data["versions"]
        if isinstance(v, dict) and isinstance(v.get("id"), str) and _VERSION_ID_RE.match(v["id"])
    ]
    return data


def _write_index(name: str, index: Dict[str, Any]) -> None:
    path = _index_path(name)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{INDEX_FILENAME}.{uuid.uuid4().hex}.tmp")
    tmp.write_text(json.dumps(index, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def _public_meta(meta: Dict[str, Any]) -> Dict[str, Any]:
    out = {k: meta.get(k) for k in _META_KEYS}
    out["trial_of"] = meta.get("trial_of")
    return out


def _find_meta(index: Dict[str, Any], version_id: str) -> Optional[Dict[str, Any]]:
    for meta in index["versions"]:
        if meta.get("id") == version_id:
            return meta
    return None


def _next_n(index: Dict[str, Any]) -> int:
    highest = max((int(v.get("n") or 0) for v in index["versions"]), default=0)
    return max(highest, int(index.get("next_n") or 0)) + 1


# ---------------------------------------------------------------------------
# Folder helpers
# ---------------------------------------------------------------------------


def _iter_files(root: Path) -> Iterator[Path]:
    """Regular files under ``root`` (sorted, no symlinks, no VCS/cache dirs)."""
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        base = Path(dirpath)
        dirnames[:] = sorted(
            d for d in dirnames
            if d not in _SKIP_PARTS and not (base / d).is_symlink()
        )
        for fname in sorted(filenames):
            path = base / fname
            if path.is_symlink() or not path.is_file():
                continue
            yield path


def _folder_sha256(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(_iter_files(root), key=lambda p: p.relative_to(root).as_posix()):
        rel = path.relative_to(root).as_posix()
        digest.update(rel.encode("utf-8") + b"\0")
        digest.update(hashlib.sha256(path.read_bytes()).hexdigest().encode("ascii") + b"\n")
    return digest.hexdigest()


def _folder_size(root: Path) -> int:
    total = 0
    for path in _iter_files(root):
        try:
            total += path.stat().st_size
        except OSError:
            continue
    return total


def _copy_folder(src: Path, dst: Path) -> None:
    dst.mkdir(parents=True, exist_ok=False)
    for path in _iter_files(src):
        target = dst / path.relative_to(src)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)


def _version_dir(name: str, version_id: str) -> Path:
    return _store_dir(name) / validate_version_id(version_id)


def _write_version_folder(name: str, version_id: str, src: Path) -> None:
    store = _store_dir(name)
    tmp = store / f".tmp-{uuid.uuid4().hex}"
    try:
        _copy_folder(src, tmp)
        os.replace(tmp, store / version_id)
    finally:
        if tmp.exists():
            shutil.rmtree(tmp, ignore_errors=True)


def _live_path_from_index(index: Dict[str, Any]) -> Optional[Path]:
    rel = index.get("live_path")
    if not isinstance(rel, str) or not rel:
        return None
    root = _skills_root().resolve()
    candidate = (root / rel).resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        return None
    if any(part.startswith(".") for part in Path(rel).parts):
        return None
    return root / rel


def _find_live_dir(name: str, index: Optional[Dict[str, Any]] = None) -> Optional[Path]:
    """The live folder of ``name`` inside the profile's own skills dir."""
    from agent.skill_utils import is_excluded_skill_path

    if index is not None:
        hinted = _live_path_from_index(index)
        if hinted is not None and hinted.name == name and (hinted / "SKILL.md").is_file():
            return hinted
    root = _skills_root()
    if not root.is_dir():
        return None
    for skill_md in root.rglob("SKILL.md"):
        if is_excluded_skill_path(skill_md):
            continue
        if skill_md.parent.name == name:
            return skill_md.parent
    return None


def _rel_live_path(live: Path) -> Optional[str]:
    try:
        return live.resolve().relative_to(_skills_root().resolve()).as_posix()
    except (OSError, ValueError):
        return None


def _clear_prompt_cache() -> None:
    try:
        from agent.prompt_builder import clear_skills_system_prompt_cache

        clear_skills_system_prompt_cache(clear_snapshot=True)
    except Exception:
        logger.debug("skill versions: prompt cache clear failed", exc_info=True)


# ---------------------------------------------------------------------------
# Authorship
# ---------------------------------------------------------------------------


@contextmanager
def author_scope(author: str) -> Iterator[None]:
    """Attribute every snapshot taken in this context to ``author``.

    The curator wraps its review pass in ``author_scope("curator")`` so the
    ``skill_manage`` writes it makes are recorded as curator versions.
    """
    token = _author_override.set(_validate_author(author))
    try:
        yield
    finally:
        _author_override.reset(token)


def current_agent_author() -> str:
    """Author for a write made by an agent tool call in this context."""
    override = _author_override.get()
    if override:
        return override
    session_id = ""
    try:
        from gateway.session_context import get_session_env

        session_id = get_session_env("HERMES_SESSION_ID", "")
    except Exception:
        session_id = os.environ.get("HERMES_SESSION_ID", "")
    session_id = "".join(ch for ch in (session_id or "") if ord(ch) >= 32)[:200]
    return f"agent:{session_id or 'unknown'}"


# ---------------------------------------------------------------------------
# Internal (lock held)
# ---------------------------------------------------------------------------


def _new_version_from_folder(
    name: str,
    index: Dict[str, Any],
    src: Path,
    *,
    author: str,
    message: str,
    source: str,
    status: str,
    parent: Optional[str],
    sha256: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    if _folder_size(src) > MAX_SNAPSHOT_BYTES:
        logger.warning("skill versions: %s is larger than the snapshot cap; not versioned", name)
        return None
    n = _next_n(index)
    version_id = f"v{n}"
    _write_version_folder(name, version_id, src)
    meta = {
        "id": version_id,
        "n": n,
        "created_at": round(time.time(), 3),
        "author": author,
        "message": message,
        "parent": parent,
        "status": status,
        "source": source,
        "sha256": sha256 or _folder_sha256(_store_dir(name) / version_id),
        "trial_of": None,
    }
    index["versions"].append(meta)
    index["next_n"] = n
    return meta


def _make_active(index: Dict[str, Any], meta: Dict[str, Any]) -> None:
    previous = index.get("active")
    for other in index["versions"]:
        if other is meta:
            continue
        if other.get("status") == STATUS_ACTIVE:
            other["status"] = STATUS_ARCHIVED
        if other.get("id") == previous:
            other["trial_of"] = None
    meta["status"] = STATUS_ACTIVE
    index["active"] = meta["id"]


def _capture_live_locked(
    name: str,
    index: Dict[str, Any],
    live: Path,
    *,
    author: str,
    message: str,
    source: str,
) -> Optional[Dict[str, Any]]:
    """Record ``live`` as the new active version unless it already is."""
    sha = _folder_sha256(live)
    active = _find_meta(index, index.get("active") or "")
    if active is not None and active.get("sha256") == sha:
        return active
    meta = _new_version_from_folder(
        name, index, live,
        author=author, message=message, source=source,
        status=STATUS_ACTIVE, parent=active["id"] if active else None, sha256=sha,
    )
    if meta is None:
        return None
    _make_active(index, meta)
    rel = _rel_live_path(live)
    if rel:
        index["live_path"] = rel
    _prune_locked(name, index)
    return meta


def _prune_locked(name: str, index: Dict[str, Any]) -> List[str]:
    cap = max_per_skill()
    active_id = index.get("active")
    active = _find_meta(index, active_id or "")
    protected = {active_id}
    if active is not None and active.get("trial_of"):
        protected.add(active["trial_of"])
    removable = sorted(
        (
            v for v in index["versions"]
            if v.get("id") not in protected and v.get("status") != STATUS_DRAFT
        ),
        key=lambda v: int(v.get("n") or 0),
    )
    pruned: List[str] = []
    while len(index["versions"]) > cap and removable:
        victim = removable.pop(0)
        index["versions"].remove(victim)
        shutil.rmtree(_store_dir(name) / victim["id"], ignore_errors=True)
        pruned.append(victim["id"])
    return pruned


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def ensure_baseline(name: str, *, skill_dir: Optional[Path] = None) -> Optional[Dict[str, Any]]:
    """Make sure the live folder's current state is recorded.

    First touch snapshots the live skill as ``v1`` (``source="baseline"``).
    If the live folder has since changed outside the version history (a
    terminal edit, a bundled sync), that state is recorded as a new version
    so the next write cannot lose it. Returns the active meta, or None when
    the skill has no live folder in this profile.
    """
    validate_name(name)
    with _skill_lock(name):
        index = _read_index(name)
        live = Path(skill_dir) if skill_dir else _find_live_dir(name, index)
        if live is None or not (live / "SKILL.md").is_file() or _rel_live_path(live) is None:
            return None
        if index["versions"]:
            message, source = "Changes made outside the version history", "edit"
        else:
            message, source = "Baseline", "baseline"
        before = (index.get("active"), index.get("live_path"))
        meta = _capture_live_locked(
            name, index, live, author="system", message=message, source=source,
        )
        if meta is not None and (meta["id"], index.get("live_path")) != before:
            _write_index(name, index)
        return _public_meta(meta) if meta else None


def snapshot(
    name: str,
    *,
    author: str,
    message: str = "",
    source: str = "edit",
    skill_dir: Optional[Path] = None,
) -> Optional[Dict[str, Any]]:
    """Record the live folder of ``name`` as the new active version.

    Call after every successful write to a live skill. A write that leaves
    the folder byte-identical to the active version records nothing and
    returns the active meta. Returns None when the skill is not versionable
    (no live folder in this profile, or larger than the snapshot cap).
    """
    validate_name(name)
    _validate_author(author)
    if source not in SOURCES:
        raise SkillVersionError("Invalid version source.")
    with _skill_lock(name):
        index = _read_index(name)
        live = Path(skill_dir) if skill_dir else _find_live_dir(name, index)
        if live is None or not (live / "SKILL.md").is_file() or _rel_live_path(live) is None:
            return None
        meta = _capture_live_locked(
            name, index, live, author=author, message=_clean_message(message), source=source,
        )
        if meta is None:
            return None
        _write_index(name, index)
        return _public_meta(meta)


def safe_snapshot(name: str, **kwargs: Any) -> Optional[Dict[str, Any]]:
    """``snapshot`` for write hooks: never raises."""
    try:
        return snapshot(name, **kwargs)
    except Exception:
        logger.debug("skill versions: snapshot of %s failed", name, exc_info=True)
        return None


def safe_ensure_baseline(name: str, **kwargs: Any) -> Optional[Dict[str, Any]]:
    """``ensure_baseline`` for write hooks: never raises."""
    try:
        return ensure_baseline(name, **kwargs)
    except Exception:
        logger.debug("skill versions: baseline of %s failed", name, exc_info=True)
        return None


def create_draft(
    name: str,
    content: str,
    *,
    author: str,
    message: str = "",
    source: str = "improve",
    base: Optional[str] = None,
) -> Dict[str, Any]:
    """Store ``content`` as a new draft SKILL.md; never touches the live folder.

    The draft copies the other files of ``base`` (default: the active
    version) so it is a complete skill folder, and records it as the parent. Agent-authored drafts go through the same security scan as
    agent skill writes.
    """
    validate_name(name)
    _validate_author(author)
    if source not in SOURCES:
        raise SkillVersionError("Invalid version source.")
    if not isinstance(content, str):
        raise SkillVersionError("content must be a string.")
    if base is not None:
        validate_version_id(base)
    from tools.skill_manager_tool import (
        _security_scan_skill,
        _validate_content_size,
        _validate_frontmatter,
    )

    err = _validate_frontmatter(content) or _validate_content_size(content)
    if err:
        raise SkillVersionError(err)

    ensure_baseline(name)
    with _skill_lock(name):
        index = _read_index(name)
        active = _find_meta(index, index.get("active") or "")
        if active is None:
            raise SkillVersionNotFound(f"Skill '{name}' not found.")
        parent = active
        if base is not None:
            parent = _find_meta(index, base)
            if parent is None:
                raise SkillVersionNotFound(f"Version '{base}' not found.")
        store = _store_dir(name)
        work = store / f".draft-{uuid.uuid4().hex}"
        try:
            _copy_folder(store / parent["id"], work)
            (work / "SKILL.md").write_text(content, encoding="utf-8")
            if author.startswith("agent:"):
                scan_error = _security_scan_skill(work)
                if scan_error:
                    raise SkillVersionError(scan_error)
            meta = _new_version_from_folder(
                name, index, work,
                author=author, message=_clean_message(message), source=source,
                status=STATUS_DRAFT, parent=parent["id"],
            )
        finally:
            shutil.rmtree(work, ignore_errors=True)
        if meta is None:
            raise SkillVersionError("Skill folder is too large to version.")
        _prune_locked(name, index)
        _write_index(name, index)
        return _public_meta(meta)


def list_versions(name: str) -> List[Dict[str, Any]]:
    """Every stored version of ``name``, oldest first (ascending ``n``)."""
    validate_name(name)
    index = _read_index(name)
    return [
        _public_meta(v)
        for v in sorted(index["versions"], key=lambda v: int(v.get("n") or 0))
    ]


def index_payload(name: str) -> Dict[str, Any]:
    """``{"name", "active", "versions"}`` — the HTTP list shape."""
    validate_name(name)
    index = _read_index(name)
    return {"name": name, "active": index.get("active"), "versions": list_versions(name)}


def current_version_id(name: str) -> Optional[str]:
    """Id of the active version of ``name`` (None if never versioned)."""
    try:
        validate_name(name)
        return _read_index(name).get("active")
    except Exception:
        return None


def _require_version(name: str, version_id: str) -> Dict[str, Any]:
    validate_name(name)
    validate_version_id(version_id)
    meta = _find_meta(_read_index(name), version_id)
    if meta is None or not _version_dir(name, version_id).is_dir():
        raise SkillVersionNotFound(f"Version '{version_id}' of '{name}' not found.")
    return meta


def get_version(name: str, version_id: str) -> Dict[str, Any]:
    """``{"meta", "content" (SKILL.md text), "files": [{"path", "size"}]}``."""
    meta = _require_version(name, version_id)
    root = _version_dir(name, version_id)
    try:
        content = (root / "SKILL.md").read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        content = ""
    files = []
    for path in _iter_files(root):
        try:
            files.append({"path": path.relative_to(root).as_posix(), "size": path.stat().st_size})
        except OSError:
            continue
    files.sort(key=lambda f: (f["path"] != "SKILL.md", f["path"]))
    return {"meta": _public_meta(meta), "content": content, "files": files}


def _read_text_or_none(path: Path) -> Optional[List[str]]:
    try:
        return path.read_text(encoding="utf-8").splitlines(keepends=True)
    except UnicodeDecodeError:
        return None


def diff(name: str, a: str, b: str) -> str:
    """Unified diff of every file between versions ``a`` and ``b``."""
    _require_version(name, a)
    _require_version(name, b)
    root_a = _version_dir(name, a)
    root_b = _version_dir(name, b)
    files_a = {p.relative_to(root_a).as_posix(): p for p in _iter_files(root_a)}
    files_b = {p.relative_to(root_b).as_posix(): p for p in _iter_files(root_b)}
    ordered = sorted(set(files_a) | set(files_b), key=lambda p: (p != "SKILL.md", p))
    chunks: List[str] = []
    for rel in ordered:
        pa, pb = files_a.get(rel), files_b.get(rel)
        if pa is not None and pb is not None and pa.read_bytes() == pb.read_bytes():
            continue
        lines_a = _read_text_or_none(pa) if pa is not None else []
        lines_b = _read_text_or_none(pb) if pb is not None else []
        if lines_a is None or lines_b is None:
            chunks.append(f"Binary files {a}/{rel} and {b}/{rel} differ\n")
            continue
        out = list(difflib.unified_diff(
            lines_a, lines_b,
            fromfile=f"{a}/{rel}" if pa is not None else "/dev/null",
            tofile=f"{b}/{rel}" if pb is not None else "/dev/null",
        ))
        for i, line in enumerate(out):
            if not line.endswith("\n"):
                out[i] = line + "\n\\ No newline at end of file\n"
        chunks.append("".join(out))
    return "".join(chunks)


def _swap_into_live(name: str, src: Path, live: Path) -> None:
    """Replace ``live`` with a copy of ``src``: stage beside it, then rename-swap.

    Staging happens in a ``.versions`` folder next to the live folder (same
    filesystem, invisible to skill scanners). The live path is missing only
    between two renames; a failed second rename puts the old folder back.
    """
    if live.is_symlink():
        raise SkillVersionError("The live skill folder is a link and cannot be replaced.")
    stage_root = live.parent / VERSIONS_DIRNAME
    created_stage_root = not stage_root.exists()
    stage_root.mkdir(parents=True, exist_ok=True)
    token = uuid.uuid4().hex
    staging = stage_root / f".stage-{name}-{token}"
    trash = stage_root / f".trash-{name}-{token}"
    try:
        _copy_folder(src, staging)
        if live.exists():
            os.replace(live, trash)
            try:
                os.replace(staging, live)
            except OSError:
                os.replace(trash, live)
                raise
        else:
            os.replace(staging, live)
    finally:
        shutil.rmtree(staging, ignore_errors=True)
        shutil.rmtree(trash, ignore_errors=True)
        if created_stage_root and stage_root != _store_root():
            try:
                stage_root.rmdir()
            except OSError:
                pass


def activate(
    name: str,
    version_id: str,
    *,
    author: str,
    trial: bool = False,
) -> Dict[str, Any]:
    """Make ``version_id`` the live skill. Returns ``{"active", "versions"}``.

    ``trial=True`` records ``trial_of`` = the previously active version so a
    client can offer Keep (activate the same id with ``trial=False``) or
    Revert (activate ``trial_of``). Unsaved live changes are recorded as a
    version first so nothing is lost by switching.
    """
    validate_name(name)
    validate_version_id(version_id)
    _validate_author(author)
    ensure_baseline(name)
    with _skill_lock(name):
        index = _read_index(name)
        target = _find_meta(index, version_id)
        if target is None or not _version_dir(name, version_id).is_dir():
            raise SkillVersionNotFound(f"Version '{version_id}' of '{name}' not found.")
        previous = index.get("active")
        if previous == version_id:
            if not trial and target.get("trial_of"):
                target["trial_of"] = None
                _write_index(name, index)
            return {"active": index.get("active"), "versions": list_versions(name)}

        live = _find_live_dir(name, index)
        if live is None:
            live = _live_path_from_index(index)
        if live is None or live.name != name:
            live = _skills_root() / name
        _swap_into_live(name, _version_dir(name, version_id), live)

        _make_active(index, target)
        target["trial_of"] = previous if (trial and previous) else None
        rel = _rel_live_path(live)
        if rel:
            index["live_path"] = rel
        _prune_locked(name, index)
        _write_index(name, index)
    _clear_prompt_cache()
    logger.info("skill versions: %s activated %s (by %s)", name, version_id, author)
    return {"active": version_id, "versions": list_versions(name)}
