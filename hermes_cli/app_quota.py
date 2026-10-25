"""FG-33 quota policy and admission for local apps (P8-1 item 1.6).

Where the numbers live is the point of this module. ``config.yaml`` is
Customizable (the agent can edit it), so limits kept there would only advise
the actor they limit. The policy therefore comes from two places the agent
cannot write:

* ``/etc/aquarium/app-quotas.yaml`` — root-owned defaults (template in
  ``deploy/install/app-quotas.yaml.example``). A file that is not a regular,
  root-owned, non group/world-writable file is ignored and the built-in
  defaults below apply instead, so loosening the file's permissions can only
  make the limits stricter, never looser.
* the ``quota_overrides`` table — per-member overrides plus the box-wide
  storage location (user id ``*``), written only through
  ``PUT /api/quotas/...`` by the owner or an admin, with a C5 change and a C8
  span for every write.

:func:`check_admission` is the one admission function the CLI, the API routes
and the root helper call before ``create|start|build|promote|
provision-external``. It is pure arithmetic over a :class:`MemberUsage` and a
:class:`BoxUsage` the caller (or :func:`probe_box`) measured:

* box-wide breaches are ``refused`` naming the binding constraint — the 6 GB
  ``aquarium.slice`` ceiling, the 3 GB box reserve, the box app count, free
  space at the storage location. The owner is not exempt from these, and an
  unmeasured box value refuses rather than admits;
* per-member and per-app breaches return ``needs_approval`` (a C6 approval to
  the owner); within limits a member is ``ok`` with no approval (decision 9);
* the owner is exempt from the per-member limits; a viewer is refused.
"""

from __future__ import annotations

import copy
import json
import logging
import os
import shutil
import stat
import subprocess
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING, Any, Literal, Mapping, Optional

import yaml

if TYPE_CHECKING:  # pragma: no cover
    import asyncpg

    from hermes_cli.access import Principal
    from hermes_cli.datastore import SupabaseAppStore

logger = logging.getLogger(__name__)

#: Root-owned policy file. Installed by the ops runbook (P8-1 1.7).
POLICY_PATH = Path("/etc/aquarium/app-quotas.yaml")
#: The uid that must own the policy file. A module constant so tests can
#: stand in for root without running as root.
_ROOT_UID = 0

#: The systemd slice every app instance and build runs in (P8-1 1.2).
APPS_PARENT_SLICE = "aquarium.slice"

#: ``user_id`` under which box-wide overrides (storage location) are stored.
BOX = "*"

QUOTA_OVERRIDES_TABLE = "quota_overrides"

Action = Literal["create", "start", "build", "promote", "provision-external"]
ACTIONS: tuple[str, ...] = ("create", "start", "build", "promote", "provision-external")
Verdict = Literal["ok", "needs_approval", "refused"]

#: An override value meaning "no limit". Only the owner may set it.
UNLIMITED = "unlimited"

#: Starting defaults (open decision 8, FG-33 §6). Calibrate on the system-test
#: box; the root file overrides any of them.
DEFAULT_POLICY: dict[str, dict[str, Any]] = {
    "per_app": {
        "memory_high_mb": 384,
        "memory_max_mb": 512,
        "cpu_quota_pct": 50,
        "disk_mb": 1536,
        "db_mb": 500,
        "db_connections": 5,
    },
    "per_member": {
        # dev and prod copies of one app count as one running app
        "apps_registered": 3,
        "apps_running": 2,
        "ram_mb": 1024,
        "disk_mb": 4096,
        "db_mb": 1024,
        "external_apps": 5,
    },
    # Per-role replacements for per_member/per_app. The owner is exempt from
    # per-member limits; admins get higher defaults, never unlimited.
    "roles": {
        "admin": {
            "per_member": {
                "apps_registered": 6,
                "apps_running": 4,
                "ram_mb": 2048,
                "disk_mb": 8192,
                "db_mb": 2048,
                "external_apps": 10,
            },
        },
    },
    "box": {
        # admission number N (FG-33 §6, disk-bound estimate)
        "apps_max": 6,
        # parent aquarium.slice MemoryMax (kernel-enforced)
        "ceiling_mb": 6144,
        # MemAvailable that must stay free for sessions, gateway, Supabase
        "reserved_mb": 3072,
        # one shared build slot (aquarium-build.slice)
        "build_mb": 2048,
    },
    # Decision 21: where app source/releases, the apps DB volume and build
    # caches live. ``base_path: null`` means the Hermes home.
    "storage": {
        "base_path": None,
        "min_free_mb": 2048,
    },
}

_INT_SECTIONS = ("per_app", "per_member", "box")
#: Keys a per-member override may set.
MEMBER_OVERRIDE_KEYS: frozenset[str] = frozenset(
    f"{section}.{key}"
    for section in ("per_app", "per_member")
    for key in DEFAULT_POLICY[section]
)
#: Keys a box-wide (``*``) override may set. ``box.*`` stays file-only: those
#: numbers mirror kernel-enforced slice caps the API cannot raise.
BOX_OVERRIDE_KEYS: frozenset[str] = frozenset(
    {"storage.base_path", "storage.min_free_mb"}
)
_MAX_INT = 10_000_000
#: Never a storage location: system trees and pseudo-filesystems.
_FORBIDDEN_STORAGE_ROOTS = (
    "/", "/bin", "/boot", "/dev", "/etc", "/lib", "/lib64", "/proc", "/root",
    "/run", "/sbin", "/sys", "/usr",
)


class QuotaError(ValueError):
    """An override key or value the policy does not accept."""


# ── policy ─────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class QuotaPolicy:
    """The resolved root policy: built-in defaults merged with the root file."""

    data: Mapping[str, Any]
    source: str = "defaults"
    warnings: tuple[str, ...] = ()

    def section(self, name: str) -> dict[str, Any]:
        return dict(self.data.get(name) or {})


def _file_is_trusted(path: Path) -> Optional[str]:
    """``None`` when ``path`` may be trusted, else why not."""
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return "missing"
    except OSError as exc:
        return f"unreadable ({exc.strerror})"
    if not stat.S_ISREG(st.st_mode):
        return "not a regular file"
    if st.st_uid != _ROOT_UID:
        return "not owned by root"
    if st.st_mode & 0o022:
        return "group- or world-writable"
    return None


def _valid_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= _MAX_INT


def _merge_file(data: dict[str, Any], raw: Mapping[str, Any]) -> list[str]:
    warnings: list[str] = []
    for section, values in raw.items():
        if section not in data:
            warnings.append(f"unknown section {section!r} ignored")
            continue
        if not isinstance(values, Mapping):
            warnings.append(f"section {section!r} is not a mapping; ignored")
            continue
        if section == "roles":
            for role, sections in values.items():
                if role not in ("admin", "member", "viewer") or not isinstance(sections, Mapping):
                    warnings.append(f"roles.{role} ignored")
                    continue
                merged = data["roles"].setdefault(role, {})
                for sub, subvalues in sections.items():
                    if sub not in ("per_app", "per_member") or not isinstance(subvalues, Mapping):
                        warnings.append(f"roles.{role}.{sub} ignored")
                        continue
                    target = merged.setdefault(sub, {})
                    for key, value in subvalues.items():
                        if key in DEFAULT_POLICY[sub] and _valid_int(value):
                            target[key] = value
                        else:
                            warnings.append(f"roles.{role}.{sub}.{key} ignored")
            continue
        for key, value in values.items():
            if key not in DEFAULT_POLICY[section]:
                warnings.append(f"unknown key {section}.{key} ignored")
                continue
            if section == "storage" and key == "base_path":
                try:
                    data[section][key] = (
                        None if value is None else validate_storage_path(value)
                    )
                except QuotaError as exc:
                    warnings.append(f"storage.base_path ignored: {exc}")
                continue
            if _valid_int(value):
                data[section][key] = value
            else:
                warnings.append(f"{section}.{key} is not a whole number; default kept")
    return warnings


def load_policy(path: Optional[Path] = None) -> QuotaPolicy:
    """Read the root policy file over the built-in defaults.

    Never raises: a missing, untrusted or malformed file leaves the defaults
    in force (and says so in ``source``/``warnings``), because a broken file
    must not turn into "no limits".
    """
    path = Path(path) if path is not None else POLICY_PATH
    data = copy.deepcopy(DEFAULT_POLICY)
    problem = _file_is_trusted(path)
    if problem == "missing":
        return QuotaPolicy(data=data, source="defaults")
    if problem is not None:
        logger.warning("app quotas: ignoring %s (%s)", path, problem)
        return QuotaPolicy(
            data=data, source="defaults", warnings=(f"{path} ignored: {problem}",)
        )
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except (OSError, yaml.YAMLError) as exc:
        logger.warning("app quotas: cannot parse %s: %s", path, exc)
        return QuotaPolicy(
            data=data, source="defaults", warnings=(f"{path} ignored: unparsable",)
        )
    if not isinstance(raw, Mapping):
        return QuotaPolicy(
            data=data, source="defaults", warnings=(f"{path} ignored: not a mapping",)
        )
    warnings = _merge_file(data, raw)
    return QuotaPolicy(data=data, source=str(path), warnings=tuple(warnings))


# ── overrides validation ──────────────────────────────────────────────────


def validate_storage_path(value: Any) -> str:
    """An absolute, normalised directory path outside system trees."""
    if not isinstance(value, str) or not value.strip():
        raise QuotaError("storage.base_path must be a non-empty path")
    if not value.startswith("/"):
        raise QuotaError("storage.base_path must be absolute")
    parts = PurePosixPath(value).parts
    if ".." in parts or "\x00" in value:
        raise QuotaError("storage.base_path may not contain '..'")
    normalised = str(PurePosixPath(value))
    for root in _FORBIDDEN_STORAGE_ROOTS:
        if normalised == root or (root != "/" and normalised.startswith(root + "/")):
            raise QuotaError(f"storage.base_path may not be under {root}")
    return normalised


def validate_override(key: str, value: Any, *, scope: str, actor_is_owner: bool) -> Any:
    """Return the stored form of one override, or raise :class:`QuotaError`.

    ``None`` means "remove the override". ``scope`` is ``"member"`` or
    ``"box"``.
    """
    allowed = BOX_OVERRIDE_KEYS if scope == "box" else MEMBER_OVERRIDE_KEYS
    if key not in allowed:
        raise QuotaError(f"{key!r} cannot be overridden here")
    if value is None:
        return None
    if key == "storage.base_path":
        return validate_storage_path(value)
    if value == UNLIMITED:
        if not actor_is_owner:
            raise QuotaError("only the owner can make a limit unlimited")
        return UNLIMITED
    if not _valid_int(value):
        raise QuotaError(f"{key} must be a whole number from 0 to {_MAX_INT}")
    return value


# ── effective limits ──────────────────────────────────────────────────────


@dataclass(frozen=True)
class Limits:
    """The limits that apply to one principal. ``None`` means unlimited."""

    role: str
    per_app: Mapping[str, Optional[int]]
    per_member: Mapping[str, Optional[int]]
    member_exempt: bool = False

    def as_dict(self) -> dict[str, Any]:
        return {
            "role": self.role,
            "member_exempt": self.member_exempt,
            "per_app": dict(self.per_app),
            "per_member": dict(self.per_member),
        }


def effective_limits(
    role: str,
    *,
    policy: Optional[QuotaPolicy] = None,
    overrides: Optional[Mapping[str, Any]] = None,
) -> Limits:
    """Defaults → root file → ``roles:`` map → that member's overrides."""
    policy = policy or load_policy()
    per_app: dict[str, Optional[int]] = policy.section("per_app")
    per_member: dict[str, Optional[int]] = policy.section("per_member")
    role_map = (policy.data.get("roles") or {}).get(role) or {}
    per_app.update(role_map.get("per_app") or {})
    per_member.update(role_map.get("per_member") or {})
    for key, value in (overrides or {}).items():
        if key not in MEMBER_OVERRIDE_KEYS:
            continue
        section, name = key.split(".", 1)
        target = per_app if section == "per_app" else per_member
        target[name] = None if value == UNLIMITED else value
    return Limits(
        role=role, per_app=per_app, per_member=per_member, member_exempt=role == "owner"
    )


def storage_base_path(
    policy: Optional[QuotaPolicy] = None,
    box_overrides: Optional[Mapping[str, Any]] = None,
) -> Path:
    """Decision 21: the configured app storage location."""
    policy = policy or load_policy()
    configured = (box_overrides or {}).get("storage.base_path") or policy.section(
        "storage"
    ).get("base_path")
    if configured:
        return Path(configured)
    from hermes_constants import get_hermes_home

    return Path(get_hermes_home())


def min_free_mb(
    policy: Optional[QuotaPolicy] = None,
    box_overrides: Optional[Mapping[str, Any]] = None,
) -> int:
    policy = policy or load_policy()
    value = (box_overrides or {}).get("storage.min_free_mb")
    if isinstance(value, int) and _valid_int(value):
        return value
    return int(policy.section("storage").get("min_free_mb") or 0)


# ── usage ─────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class MemberUsage:
    """What one member already uses. Measured by the caller (FG-33 §6)."""

    #: slugs of the member's registered local apps
    registered: frozenset[str] = frozenset()
    #: slugs with a dev or prod instance running (dev+prod count once)
    running: frozenset[str] = frozenset()
    ram_mb: float = 0.0
    disk_mb: float = 0.0
    db_mb: float = 0.0
    external_apps: int = 0


@dataclass(frozen=True)
class BoxUsage:
    """Box-wide measurements. ``None`` = could not be measured (fails closed)."""

    apps_registered: Optional[int] = None
    slice_memory_mb: Optional[float] = None
    mem_available_mb: Optional[float] = None
    storage_free_mb: Optional[float] = None
    storage_path: str = ""


@dataclass(frozen=True)
class AdmissionRequest:
    """What the action asks for. Unset sizes default from the per-app limits."""

    tool: str = ""
    memory_mb: Optional[float] = None
    disk_mb: Optional[float] = None
    db_mb: Optional[float] = None


def _slice_memory_mb(slice_name: str = APPS_PARENT_SLICE) -> Optional[float]:
    systemctl = shutil.which("systemctl")
    if systemctl is None:
        return None
    try:
        proc = subprocess.run(
            [systemctl, "show", "-p", "LoadState", "-p", "MemoryCurrent", slice_name],
            capture_output=True, text=True, timeout=5, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0:
        return None
    props = dict(
        line.split("=", 1) for line in proc.stdout.splitlines() if "=" in line
    )
    if props.get("LoadState") != "loaded":
        return None
    current = props.get("MemoryCurrent", "")
    if current.isdigit():
        return int(current) / 1048576.0
    # "[not set]": the slice is loaded but holds no running unit.
    return 0.0


def _mem_available_mb() -> Optional[float]:
    try:
        with open("/proc/meminfo", encoding="ascii") as handle:
            for line in handle:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) / 1024.0
    except (OSError, ValueError, IndexError):
        return None
    return None


def _free_mb(path: Path) -> Optional[float]:
    probe = path
    while not probe.exists():
        if probe.parent == probe:
            return None
        probe = probe.parent
    try:
        return shutil.disk_usage(probe).free / 1048576.0
    except OSError:
        return None


def probe_box(
    *,
    apps_registered: Optional[int],
    policy: Optional[QuotaPolicy] = None,
    box_overrides: Optional[Mapping[str, Any]] = None,
) -> BoxUsage:
    """Measure the box live: slice ``MemoryCurrent``, ``MemAvailable`` and free
    space at the configured storage location. ``apps_registered`` comes from
    the registry, which the caller already holds."""
    base = storage_base_path(policy, box_overrides)
    return BoxUsage(
        apps_registered=apps_registered,
        slice_memory_mb=_slice_memory_mb(),
        mem_available_mb=_mem_available_mb(),
        storage_free_mb=_free_mb(base),
        storage_path=str(base),
    )


# ── admission ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Admission:
    verdict: Verdict
    reason: str
    constraint: Optional[str] = None
    limits: Optional[Limits] = None
    details: Mapping[str, Any] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return self.verdict == "ok"

    def as_dict(self) -> dict[str, Any]:
        return {
            "verdict": self.verdict,
            "reason": self.reason,
            "constraint": self.constraint,
            "limits": self.limits.as_dict() if self.limits else None,
            "details": dict(self.details),
        }


def _refused(constraint: str, reason: str, limits: Limits, **details: Any) -> Admission:
    return Admission("refused", reason, constraint, limits, details)


def _approval(constraint: str, reason: str, limits: Limits, **details: Any) -> Admission:
    return Admission("needs_approval", reason, constraint, limits, details)


def _over(limit: Optional[int], value: float) -> bool:
    return limit is not None and value > limit


def check_admission(
    principal: "Principal",
    action: str,
    *,
    usage: MemberUsage,
    box: BoxUsage,
    request: Optional[AdmissionRequest] = None,
    policy: Optional[QuotaPolicy] = None,
    overrides: Optional[Mapping[str, Any]] = None,
    box_overrides: Optional[Mapping[str, Any]] = None,
) -> Admission:
    """Admit, ask for approval, or refuse one app action (FG-33 §6).

    Box-wide limits are checked first and refuse; per-member and per-app limits
    then ask for approval. Pure: every input is passed in.
    """
    if action not in ACTIONS:
        raise ValueError(f"unknown admission action {action!r}")
    policy = policy or load_policy()
    role = str(getattr(principal, "role", "") or "")
    limits = effective_limits(role, policy=policy, overrides=overrides)
    if role not in ("owner", "admin", "member"):
        return _refused("role", "A viewer cannot create or run apps.", limits)
    request = request or AdmissionRequest()
    boxp = policy.section("box")
    per_app = limits.per_app

    # ── box-wide: refused, owner included ──
    if action in ("start", "build", "promote"):
        if action == "build":
            need_mb = request.memory_mb if request.memory_mb is not None else boxp["build_mb"]
        else:
            need_mb = (
                request.memory_mb
                if request.memory_mb is not None
                else per_app.get("memory_max_mb") or 0
            )
        if box.slice_memory_mb is None:
            return _refused(
                APPS_PARENT_SLICE,
                f"Cannot {action}: {APPS_PARENT_SLICE} memory use could not be measured.",
                limits,
            )
        if box.slice_memory_mb + need_mb > boxp["ceiling_mb"]:
            return _refused(
                APPS_PARENT_SLICE,
                f"Cannot {action}: local apps would use more than "
                f"{boxp['ceiling_mb']} MB ({APPS_PARENT_SLICE} ceiling).",
                limits, used_mb=round(box.slice_memory_mb), request_mb=need_mb,
            )
        if box.mem_available_mb is None:
            return _refused(
                "box.reserved_mb",
                f"Cannot {action}: free memory on the server could not be measured.",
                limits,
            )
        if box.mem_available_mb - need_mb < boxp["reserved_mb"]:
            return _refused(
                "box.reserved_mb",
                f"Cannot {action}: the server must keep {boxp['reserved_mb']} MB "
                "free for chats and core services.",
                limits, available_mb=round(box.mem_available_mb), request_mb=need_mb,
            )
    if action in ("create", "build", "promote"):
        if action == "create":
            need_disk = request.disk_mb if request.disk_mb is not None else per_app.get("disk_mb") or 0
        else:
            need_disk = request.disk_mb or 0
        floor = min_free_mb(policy, box_overrides)
        if box.storage_free_mb is None:
            return _refused(
                "storage",
                f"Cannot {action}: free space at the app storage location could not be measured.",
                limits, path=box.storage_path,
            )
        if box.storage_free_mb - need_disk < floor:
            return _refused(
                "storage",
                f"Cannot {action}: not enough free disk at {box.storage_path or 'the app storage location'} "
                f"(must keep {floor} MB free).",
                limits, free_mb=round(box.storage_free_mb), request_mb=need_disk,
                path=box.storage_path,
            )
    if action == "create" and request.tool not in usage.registered:
        if box.apps_registered is None:
            return _refused("box.apps_max", "Cannot create: the number of apps on this server is unknown.", limits)
        if box.apps_registered + 1 > boxp["apps_max"]:
            return _refused(
                "box.apps_max",
                f"Cannot create: this server already holds {box.apps_registered} local apps "
                f"(limit {boxp['apps_max']}).",
                limits,
            )

    if limits.member_exempt:
        return Admission("ok", "Within limits.", None, limits)

    # ── per member / per app: needs approval ──
    pm = limits.per_member
    if action == "create":
        if request.tool not in usage.registered and _over(
            pm.get("apps_registered"), len(usage.registered) + 1
        ):
            return _approval(
                "per_member.apps_registered",
                f"You already have {len(usage.registered)} local apps (limit {pm['apps_registered']}).",
                limits,
            )
        need_disk = request.disk_mb if request.disk_mb is not None else per_app.get("disk_mb") or 0
        if _over(pm.get("disk_mb"), usage.disk_mb + need_disk):
            return _approval(
                "per_member.disk_mb",
                f"Your apps would use more than {pm['disk_mb']} MB of disk.", limits,
            )
    if action in ("create", "promote"):
        need_db = request.db_mb if request.db_mb is not None else per_app.get("db_mb") or 0
        if _over(per_app.get("db_mb"), need_db):
            return _approval(
                "per_app.db_mb", f"One app database may hold at most {per_app['db_mb']} MB.", limits,
            )
        if _over(pm.get("db_mb"), usage.db_mb + need_db):
            return _approval(
                "per_member.db_mb",
                f"Your app databases would hold more than {pm['db_mb']} MB.", limits,
            )
    if action in ("start", "promote"):
        if request.tool not in usage.running and _over(
            pm.get("apps_running"), len(usage.running) + 1
        ):
            return _approval(
                "per_member.apps_running",
                f"You already have {len(usage.running)} apps running (limit {pm['apps_running']}).",
                limits,
            )
        need_mb = request.memory_mb if request.memory_mb is not None else per_app.get("memory_max_mb") or 0
        if _over(per_app.get("memory_max_mb"), need_mb):
            return _approval(
                "per_app.memory_max_mb",
                f"One app may use at most {per_app['memory_max_mb']} MB of memory.", limits,
            )
        if _over(pm.get("ram_mb"), usage.ram_mb + need_mb):
            return _approval(
                "per_member.ram_mb",
                f"Your running apps would use more than {pm['ram_mb']} MB of memory.", limits,
            )
    if action == "build" and _over(pm.get("disk_mb"), usage.disk_mb + (request.disk_mb or 0)):
        return _approval(
            "per_member.disk_mb", f"Your apps would use more than {pm['disk_mb']} MB of disk.", limits,
        )
    if action == "provision-external" and _over(
        pm.get("external_apps"), usage.external_apps + 1
    ):
        return _approval(
            "per_member.external_apps",
            f"You already have {usage.external_apps} hosted apps (limit {pm['external_apps']}).",
            limits,
        )
    return Admission("ok", "Within limits.", None, limits)


# ── quota_overrides (owner/admin-only writes) ─────────────────────────────


def _overrides_schema_sql() -> str:
    return f"""
    CREATE TABLE IF NOT EXISTS {QUOTA_OVERRIDES_TABLE} (
        user_id      TEXT NOT NULL,
        key          TEXT NOT NULL,
        value        JSONB NOT NULL,
        set_by       TEXT NOT NULL,
        approval_ref TEXT,
        change_ref   TEXT,
        ts           TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, key)
    );
    REVOKE ALL ON {QUOTA_OVERRIDES_TABLE} FROM PUBLIC;
    """


def _may_edit(actor: "Principal", target_user_id: str, target_role: Optional[str]) -> Optional[str]:
    """``None`` when ``actor`` may edit ``target``'s quotas, else why not.

    Owner: anyone. Admin: members and viewers and the box storage location,
    never their own or another admin's or the owner's limits (no
    self-escalation). Everyone else: nobody.
    """
    if actor.is_owner:
        return None
    if actor.role != "admin":
        return "Only the owner or an admin can change quotas."
    if target_user_id == BOX:
        return None
    if target_user_id == actor.user_id:
        return "An admin cannot change their own quotas."
    if target_role in ("owner", "admin"):
        return "Only the owner can change an admin's or the owner's quotas."
    return None


class QuotaStore:
    """Async access to ``quota_overrides`` through the C3 app store."""

    def __init__(self, store: "SupabaseAppStore", *, config: Optional[Mapping[str, Any]] = None) -> None:
        self._store = store
        self._config = dict(config or {})

    async def _connect(self) -> "asyncpg.Connection":
        connection = await self._store.connect()
        await connection.execute(f'CREATE SCHEMA IF NOT EXISTS "{self._store.schema}"')
        await connection.execute(_overrides_schema_sql())
        return connection

    async def overrides_for(self, user_id: str) -> dict[str, Any]:
        conn = await self._connect()
        try:
            rows = await conn.fetch(
                f"SELECT key, value FROM {QUOTA_OVERRIDES_TABLE} WHERE user_id = $1",
                user_id,
            )
        finally:
            await conn.close()
        return {row["key"]: json.loads(row["value"]) for row in rows}

    async def limits_for(self, principal: "Principal", *, policy: Optional[QuotaPolicy] = None) -> Limits:
        return effective_limits(
            principal.role, policy=policy, overrides=await self.overrides_for(principal.user_id)
        )

    async def set_overrides(
        self,
        actor: "Principal",
        user_id: str,
        values: Mapping[str, Any],
        *,
        target_role: Optional[str] = None,
    ) -> dict[str, Any]:
        """Write overrides for ``user_id`` (or :data:`BOX`) as ``actor``.

        Raises ``PermissionError`` for an actor who may not, and
        :class:`QuotaError` for a bad key/value; nothing is written then.
        Records one C5 ``config`` change (inverse = the previous values) in
        the same transaction, then a C8 span.
        """
        denied = _may_edit(actor, user_id, target_role)
        if denied:
            raise PermissionError(denied)
        if not values:
            raise QuotaError("no quota values given")
        scope = "box" if user_id == BOX else "member"
        clean = {
            key: validate_override(key, value, scope=scope, actor_is_owner=actor.is_owner)
            for key, value in values.items()
        }
        from hermes_cli.changes import ChangeLog, initialize_changes

        conn = await self._connect()
        try:
            await initialize_changes(conn)
            async with conn.transaction():
                rows = await conn.fetch(
                    f"SELECT key, value FROM {QUOTA_OVERRIDES_TABLE} WHERE user_id = $1 FOR UPDATE",
                    user_id,
                )
                before = {row["key"]: json.loads(row["value"]) for row in rows}
                target = f"quota:{user_id}"
                result = await ChangeLog(self._store, config=self._config).record(
                    actor_user_id=actor.user_id,
                    target_kind="config",
                    op=[{"op": "set", "path": f"/quotas/{user_id}/{k}", "value": v} for k, v in clean.items()],
                    inverse_op=[
                        {"op": "set", "path": f"/quotas/{user_id}/{k}", "value": before.get(k)}
                        for k in clean
                    ],
                    reversible=True,
                    action="quota.set",
                    target_ref=target,
                    mode=self._store.mode,
                    payload={"user_id": user_id, "values": clean, "previous": {k: before.get(k) for k in clean}},
                    approved=True,
                    connection=conn,
                )
                for key, value in clean.items():
                    if value is None:
                        await conn.execute(
                            f"DELETE FROM {QUOTA_OVERRIDES_TABLE} WHERE user_id = $1 AND key = $2",
                            user_id, key,
                        )
                        continue
                    await conn.execute(
                        f"""
                        INSERT INTO {QUOTA_OVERRIDES_TABLE}
                            (user_id, key, value, set_by, approval_ref, change_ref, ts)
                        VALUES ($1, $2, $3::jsonb, $4, $5, $6, now())
                        ON CONFLICT (user_id, key) DO UPDATE SET
                            value = EXCLUDED.value, set_by = EXCLUDED.set_by,
                            approval_ref = EXCLUDED.approval_ref,
                            change_ref = EXCLUDED.change_ref, ts = now()
                        """,
                        user_id, key, json.dumps(value), actor.user_id,
                        result.approval_ref, result.change_ref,
                    )
                after_rows = await conn.fetch(
                    f"SELECT key, value FROM {QUOTA_OVERRIDES_TABLE} WHERE user_id = $1",
                    user_id,
                )
        finally:
            await conn.close()
        await self._record_span(actor.user_id, target, result.change_ref)
        return {
            "user_id": user_id,
            "overrides": {row["key"]: json.loads(row["value"]) for row in after_rows},
            "change_ref": result.change_ref,
        }

    async def _record_span(self, actor_user_id: str, ref: str, change_ref: str) -> None:
        from hermes_cli.interactions import Interaction, InteractionLedger

        try:
            await InteractionLedger(self._store, config=self._config).append(
                Interaction(
                    id=f"int_{uuid.uuid4().hex}",
                    trace_id=f"trc_{uuid.uuid4().hex}",
                    parent_id=None,
                    ts=datetime.now(timezone.utc),
                    actor_user_id=actor_user_id,
                    session_key="quotas-api",
                    platform="api",
                    kind="change",
                    ref=ref,
                    summary=f"quota.set ({change_ref})",
                    payload_ref=None,
                    mode=self._store.mode,
                )
            )
        except Exception as exc:  # noqa: BLE001 - the C5 row is the record of truth
            logger.warning("app quotas: C8 span not written: %s", exc)
