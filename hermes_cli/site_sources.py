"""Site-to-schema: the registry, one database schema per source site, and the writer.

Plan: ``docs/plans/2026-11-10-001-site-to-schema-plan.md`` (contracts in §3).

* The registry (``public.site_sources`` / ``public.site_source_grants``) says
  which sites exist, who owns each one and who else may read or manage it.
* Every site gets its own schema ``site_<slug>``. Its content tables are made
  from an approved design (:func:`apply_design`), additively: a column or table
  is never dropped or retyped.
* Two login roles per site keep the data apart from everything else in the app
  database: ``site_<slug>_rw`` (rows of that schema only; the writer) and
  ``site_<slug>_ro`` (``SELECT`` on that schema only; every read, including the
  agent's free-form SQL). Neither can see the app schemas, so a query typed in
  chat cannot reach another person's data. They follow the
  :func:`hermes_cli.access.ensure_read_role` pattern: ``LOGIN`` roles connected
  to directly, never a ``GRANT role TO CURRENT_USER`` (that faults the event
  trigger on self-hosted Supabase).
* :class:`SiteWriter` stores what a refresh extracted: variable content is
  inserted, updated or restored by key, fixed content is versioned, and rows
  that disappeared are marked removed — only after a *full* refresh of that
  entity finished cleanly, never deleted.

Nothing here opens a database port: all access goes through the Aquarium API
(:mod:`hermes_cli.site_sources_api`) and the ``site_db`` agent tool.
"""

from __future__ import annotations

import asyncio
import contextlib
import csv
import hashlib
import importlib
import inspect
import io
import json
import logging
import os
import re
import secrets
import sys
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, Iterator, List, Mapping, Optional, Sequence, Set, Tuple
from urllib.parse import quote, unquote, urlsplit, urlunsplit

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Vocabulary
# ---------------------------------------------------------------------------

STATUSES = ("draft", "studying", "awaiting_approval", "active", "paused", "error")
REFRESH_MODES = ("incremental", "full")
TRIGGERS = ("manual", "schedule", "agent")
GRANTS = ("read", "admin")
KINDS = ("fixed", "variable")
DEFAULT_CREATE_ROLES = ("owner", "admin")

CREDENTIAL_PROVIDER = "site-login"
CREDENTIAL_KIND = "site-login"

#: Design column type -> Postgres type. Anything else is refused.
COLUMN_TYPES: Dict[str, str] = {
    "text": "text",
    "integer": "bigint",
    "bigint": "bigint",
    "number": "numeric",
    "numeric": "numeric",
    "boolean": "boolean",
    "date": "date",
    "timestamp": "timestamptz",
    "timestamptz": "timestamptz",
    "json": "jsonb",
    "jsonb": "jsonb",
}
#: ``information_schema.columns.data_type`` -> the Postgres type above.
_PG_DATA_TYPES = {
    "text": "text",
    "bigint": "bigint",
    "numeric": "numeric",
    "boolean": "boolean",
    "date": "date",
    "timestamp with time zone": "timestamptz",
    "jsonb": "jsonb",
}

STANDARD_COLUMNS = (
    ("_key", "text PRIMARY KEY"),
    ("_hash", "text NOT NULL"),
    ("_payload", "jsonb NOT NULL"),
    ("_first_seen", "timestamptz NOT NULL DEFAULT now()"),
    ("_last_seen", "timestamptz NOT NULL DEFAULT now()"),
    ("_removed_at", "timestamptz"),
    ("_run_id", "uuid"),
)
#: Tables every site schema has; an entity may not take one of these names.
META_TABLES = ("_meta", "_designs", "_runs", "_fixed_versions", "_changes")

_SLUG_RE = re.compile(r"^[a-z][a-z0-9_]{0,39}$")
_NAME_RE = re.compile(r"^[a-z][a-z0-9_]{0,47}$")
_COLUMN_RE = re.compile(r"^[a-z][a-z0-9_]{0,58}$")
_CRON_RE = re.compile(r"^[0-9*/,\- A-Za-z?#LW]{1,120}$")

MAX_QUERY_ROWS = 500
MAX_EXPORT_ROWS = 200_000
QUERY_TIMEOUT_MS = 30_000
PAGE_SIZE = 50


class SiteError(Exception):
    """A refusal with the HTTP status the API should answer with."""

    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


class DesignConflict(SiteError):
    """A design that would need a destructive change (drop or retype)."""

    def __init__(self, message: str) -> None:
        super().__init__(message, 409)


# ---------------------------------------------------------------------------
# Names
# ---------------------------------------------------------------------------


def normalize_slug(value: Any) -> str:
    """``"HSDOS WMS"`` -> ``"hsdos_wms"``; refuse what cannot be one."""
    text = re.sub(r"[^a-z0-9]+", "_", str(value or "").strip().lower()).strip("_")
    if text and text[0].isdigit():
        text = f"s_{text}"
    text = text[:40].rstrip("_")
    if not _SLUG_RE.fullmatch(text):
        raise SiteError("site name must contain letters or digits")
    return text


def schema_name(slug: str) -> str:
    if not _SLUG_RE.fullmatch(slug):
        raise SiteError(f"invalid site slug {slug!r}")
    return f"site_{slug}"


def writer_role(slug: str) -> str:
    return f"{schema_name(slug)}_rw"


def reader_role(slug: str) -> str:
    return f"{schema_name(slug)}_ro"


def _ident(name: str) -> str:
    """Quote a validated identifier."""
    if not re.fullmatch(r"[a-z_][a-z0-9_]{0,62}", name):
        raise SiteError(f"invalid identifier {name!r}")
    return f'"{name}"'


def _qualified(schema: str, table: str) -> str:
    return f"{_ident(schema)}.{_ident(table)}"


# ---------------------------------------------------------------------------
# Design + recipe validation (§3.3 / §3.4)
# ---------------------------------------------------------------------------


def validate_design(design: Any) -> Dict[str, Any]:
    """Return a normalised copy of ``design`` or raise :class:`SiteError`."""
    if isinstance(design, str):
        try:
            design = json.loads(design)
        except ValueError:
            raise SiteError("design must be JSON") from None
    if not isinstance(design, Mapping):
        raise SiteError("design must be an object")
    entities = design.get("entities")
    if not isinstance(entities, list) or not entities:
        raise SiteError("design.entities must be a non-empty list")
    seen: Set[str] = set()
    out: List[Dict[str, Any]] = []
    for raw in entities:
        if not isinstance(raw, Mapping):
            raise SiteError("each entity must be an object")
        name = str(raw.get("name") or "")
        if not _NAME_RE.fullmatch(name) or name in META_TABLES:
            raise SiteError(
                f"entity name {name!r} must be lower-case letters, digits and _ "
                "(starting with a letter)"
            )
        if name in seen:
            raise SiteError(f"entity {name!r} appears twice")
        seen.add(name)
        kind = raw.get("kind")
        if kind not in KINDS:
            raise SiteError(f"entity {name!r}: kind must be fixed or variable")
        columns: List[Dict[str, str]] = []
        col_names: Set[str] = set()
        for col in raw.get("columns") or []:
            if not isinstance(col, Mapping):
                raise SiteError(f"entity {name!r}: each column must be an object")
            cname = str(col.get("name") or "")
            ctype = str(col.get("type") or "text").lower()
            if not _COLUMN_RE.fullmatch(cname):
                raise SiteError(f"entity {name!r}: invalid column name {cname!r}")
            if cname in col_names:
                raise SiteError(f"entity {name!r}: column {cname!r} appears twice")
            if ctype not in COLUMN_TYPES:
                raise SiteError(
                    f"entity {name!r}: column {cname!r} type must be one of "
                    + ", ".join(sorted(COLUMN_TYPES))
                )
            col_names.add(cname)
            columns.append({"name": cname, "type": ctype})
        key = raw.get("key") or []
        if isinstance(key, str):
            key = [key]
        if not isinstance(key, list) or any(k not in col_names for k in key):
            raise SiteError(f"entity {name!r}: key must list some of its columns")
        if kind == "variable" and not key:
            raise SiteError(f"entity {name!r}: a variable entity needs a key")
        refresh = dict(raw.get("refresh") or {})
        mode = refresh.get("mode") or ("incremental" if refresh.get("cursor") else "full")
        if mode not in REFRESH_MODES:
            raise SiteError(f"entity {name!r}: refresh.mode must be incremental or full")
        cursor = refresh.get("cursor")
        if cursor is not None and cursor not in col_names:
            raise SiteError(f"entity {name!r}: refresh.cursor must be one of its columns")
        if mode == "incremental" and kind == "fixed":
            raise SiteError(f"entity {name!r}: fixed content is always refreshed in full")
        full_every = refresh.get("full_every")
        if full_every is not None:
            parse_duration(full_every)
        refresh["mode"] = mode
        entity = dict(raw)
        entity.update(name=name, kind=kind, columns=columns, key=list(key), refresh=refresh)
        entity.setdefault("reason", "")
        entity.setdefault("question", None)
        out.append(entity)
    result = dict(design)
    result["entities"] = out
    return result


#: Words that mark a step target as something that changes the source site.
_FORBIDDEN_WORDS = re.compile(
    r"\b(save|add|new|create|edit|update|delete|remove|logout|log ?out|sign ?out|"
    r"change[ _-]?password|submit[ _-]?order|approve|reject|cancel)\b",
    re.IGNORECASE,
)


def check_recipe(recipe: Any) -> Dict[str, Any]:
    """Shape check of a recipe; the runner (workstream B) owns full validation.

    Delegates to ``site_recipe_runner.validate_recipe`` when it exists; until
    then refuses the obvious: non-objects and click/submit steps that name a
    forbidden target (§3.4, D9).
    """
    if isinstance(recipe, str):
        try:
            recipe = json.loads(recipe)
        except ValueError:
            raise SiteError("recipe must be JSON") from None
    if not isinstance(recipe, Mapping):
        raise SiteError("recipe must be an object")
    try:
        runner_module: Any = _runner_module()
    except ImportError:
        runner_module = None
    validator = getattr(runner_module, "validate_recipe", None)
    if callable(validator):
        try:
            validator(recipe)
        except SiteError:
            raise
        except Exception as exc:  # noqa: BLE001 - the runner's own error type
            raise SiteError(f"recipe refused: {exc}") from exc
        return dict(recipe)
    entities = recipe.get("entities") or {}
    steps: List[Any] = []
    if isinstance(entities, Mapping):
        for value in entities.values():
            steps.extend(value.get("steps", []) if isinstance(value, Mapping) else value or [])
    elif isinstance(entities, list):
        for value in entities:
            if isinstance(value, Mapping):
                steps.extend(value.get("steps") or [])
    for step in steps:
        if not isinstance(step, Mapping):
            continue
        if str(step.get("action") or step.get("op") or step.get("type") or "") not in (
            "click",
            "submit",
        ):
            continue
        target = " ".join(str(step.get(k) or "") for k in ("selector", "text", "label"))
        if _FORBIDDEN_WORDS.search(target):
            raise SiteError(f"recipe step targets a forbidden control: {target.strip()!r}")
    return dict(recipe)


_DURATION_RE = re.compile(
    r"^P(?:(?P<w>\d+)W)?(?:(?P<d>\d+)D)?(?:T(?:(?P<h>\d+)H)?(?:(?P<m>\d+)M)?)?$"
)


def parse_duration(value: Any) -> timedelta:
    """ISO-8601 ``PnW`` / ``PnDTnHnM`` -> timedelta."""
    match = _DURATION_RE.fullmatch(str(value or "").upper())
    if not match or not any(match.groupdict().values()):
        raise SiteError(f"invalid duration {value!r} (use e.g. P7D or PT12H)")
    parts = {k: int(v or 0) for k, v in match.groupdict().items()}
    return timedelta(weeks=parts["w"], days=parts["d"], hours=parts["h"], minutes=parts["m"])


def validate_cron(value: Any) -> Optional[str]:
    if value in (None, ""):
        return None
    text = str(value).strip()
    if not _CRON_RE.fullmatch(text):
        raise SiteError("schedule must be a cron expression like '0 6 * * *'")
    try:
        from croniter import croniter

        croniter(text)
    except Exception:  # noqa: BLE001 - croniter raises several types
        raise SiteError(f"invalid cron expression {text!r}") from None
    return text


# ---------------------------------------------------------------------------
# DDL (pure; §3.2)
# ---------------------------------------------------------------------------


def meta_ddl(schema: str) -> List[str]:
    """Statements that create the fixed tables of a site schema (idempotent)."""
    s = _ident(schema)
    return [
        f"CREATE SCHEMA IF NOT EXISTS {s}",
        f"CREATE TABLE IF NOT EXISTS {s}._meta (key text PRIMARY KEY, value jsonb)",
        f"""CREATE TABLE IF NOT EXISTS {s}._designs (
            version int PRIMARY KEY,
            design jsonb NOT NULL,
            recipe jsonb,
            status text NOT NULL DEFAULT 'proposed'
                CHECK (status IN ('proposed', 'approved', 'superseded')),
            proposed_by text,
            proposed_at timestamptz NOT NULL DEFAULT now(),
            approved_by text,
            approved_at timestamptz)""",
        f"""CREATE TABLE IF NOT EXISTS {s}._runs (
            id uuid PRIMARY KEY,
            mode text NOT NULL CHECK (mode IN ('incremental', 'full')),
            trigger text NOT NULL CHECK (trigger IN ('manual', 'schedule', 'agent')),
            started_at timestamptz NOT NULL DEFAULT now(),
            finished_at timestamptz,
            status text NOT NULL DEFAULT 'running'
                CHECK (status IN ('running', 'ok', 'partial', 'error')),
            pages int NOT NULL DEFAULT 0,
            inserted int NOT NULL DEFAULT 0,
            updated int NOT NULL DEFAULT 0,
            removed int NOT NULL DEFAULT 0,
            versions int NOT NULL DEFAULT 0,
            error text,
            detail jsonb)""",
        f"""CREATE TABLE IF NOT EXISTS {s}._fixed_versions (
            entity text NOT NULL,
            content_key text NOT NULL,
            version int NOT NULL,
            content_hash text NOT NULL,
            payload jsonb NOT NULL,
            valid_from timestamptz NOT NULL DEFAULT now(),
            valid_to timestamptz,
            run_id uuid,
            PRIMARY KEY (entity, content_key, version))""",
        f"""CREATE TABLE IF NOT EXISTS {s}._changes (
            id bigserial PRIMARY KEY,
            entity text NOT NULL,
            key text NOT NULL,
            run_id uuid,
            op text NOT NULL
                CHECK (op IN ('insert', 'update', 'remove', 'restore', 'version')),
            before jsonb,
            after jsonb,
            at timestamptz NOT NULL DEFAULT now())""",
        f"CREATE INDEX IF NOT EXISTS _changes_entity_key ON {s}._changes (entity, key, at)",
    ]


def design_ddl(
    schema: str,
    design: Mapping[str, Any],
    existing: Mapping[str, Mapping[str, str]],
) -> List[str]:
    """Statements that bring ``schema`` up to ``design`` without losing anything.

    ``existing`` maps table -> {column: postgres type} as it is now. New tables
    and new columns are created; a column whose type would change is a
    :class:`DesignConflict`; tables and columns the design no longer names stay.
    Fixed entities live in ``_fixed_versions`` and need no table.
    """
    design = validate_design(design)
    statements: List[str] = []
    conflicts: List[str] = []
    for entity in design["entities"]:
        if entity["kind"] != "variable":
            continue
        name = entity["name"]
        table = _qualified(schema, name)
        wanted = [(c["name"], COLUMN_TYPES[c["type"]]) for c in entity["columns"]]
        have = existing.get(name)
        if have is None:
            cols = [f"{_ident(n)} {t}" for n, t in STANDARD_COLUMNS]
            cols += [f"{_ident(n)} {t}" for n, t in wanted]
            statements.append(f"CREATE TABLE {table} (\n    " + ",\n    ".join(cols) + ")")
            statements.append(
                f"CREATE INDEX {_ident(name + '_last_seen')} ON {table} (_last_seen)"
            )
            continue
        for std, _ in STANDARD_COLUMNS:
            if std not in have:
                conflicts.append(f"table {name} exists but is not a site table (no {std})")
                break
        for cname, ctype in wanted:
            current = have.get(cname)
            if current is None:
                statements.append(f"ALTER TABLE {table} ADD COLUMN {_ident(cname)} {ctype}")
            elif current != ctype:
                conflicts.append(
                    f"{name}.{cname} is {current}; the design asks for {ctype} "
                    "(columns are never retyped: add a new column instead)"
                )
    if conflicts:
        raise DesignConflict("; ".join(conflicts))
    return statements


def role_grant_sql(schema: str, *, rw: str, ro: str) -> List[str]:
    """Grants that confine the two site roles to their own schema."""
    s = _ident(schema)
    return [
        f"REVOKE ALL ON SCHEMA {s} FROM PUBLIC",
        f"GRANT USAGE ON SCHEMA {s} TO {rw}, {ro}",
        f"GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA {s} TO {rw}",
        f"GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA {s} TO {rw}",
        f"GRANT SELECT ON ALL TABLES IN SCHEMA {s} TO {ro}",
        f"ALTER DEFAULT PRIVILEGES IN SCHEMA {s} GRANT SELECT, INSERT, UPDATE ON TABLES TO {rw}",
        f"ALTER DEFAULT PRIVILEGES IN SCHEMA {s} GRANT USAGE, SELECT ON SEQUENCES TO {rw}",
        f"ALTER DEFAULT PRIVILEGES IN SCHEMA {s} GRANT SELECT ON TABLES TO {ro}",
    ]


# ---------------------------------------------------------------------------
# Writer decisions (pure)
# ---------------------------------------------------------------------------


def content_hash(payload: Any) -> str:
    text = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str, ensure_ascii=False)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def record_key(entity: Mapping[str, Any], payload: Mapping[str, Any]) -> str:
    """The row key from the entity's key columns (``|``-joined)."""
    parts = []
    for col in entity.get("key") or []:
        value = payload.get(col)
        if value is None or str(value).strip() == "":
            raise SiteError(f"{entity['name']}: record has no value for key {col!r}")
        parts.append(str(value).strip())
    if not parts:
        return "page"
    return "|".join(parts)


def decide_upsert(existing: Optional[Mapping[str, Any]], new_hash: str) -> Optional[str]:
    """``insert`` | ``restore`` | ``update`` | ``None`` (unchanged, just seen)."""
    if existing is None:
        return "insert"
    if existing.get("_removed_at") is not None:
        return "restore"
    if existing.get("_hash") != new_hash:
        return "update"
    return None


def decide_fixed(
    latest: Optional[Mapping[str, Any]], new_hash: str
) -> Optional[str]:
    """``insert`` (first) | ``version`` (changed) | ``restore`` (came back) | ``None``."""
    if latest is None:
        return "insert"
    if latest.get("valid_to") is not None:
        return "restore"
    if latest.get("content_hash") != new_hash:
        return "version"
    return None


_TRUE = {"true", "yes", "y", "1", "on", "t"}
_FALSE = {"false", "no", "n", "0", "off", "f"}


def coerce(value: Any, design_type: str) -> Any:
    """``value`` as the Python type asyncpg wants for ``design_type``, or None."""
    if value is None or (isinstance(value, str) and value.strip() == ""):
        return None
    pg = COLUMN_TYPES[design_type]
    try:
        if pg == "text":
            return value if isinstance(value, str) else json.dumps(value, default=str) if isinstance(value, (dict, list)) else str(value)
        if pg == "bigint":
            if isinstance(value, bool):
                return int(value)
            return int(Decimal(str(value).replace(",", "").strip()))
        if pg == "numeric":
            return Decimal(str(value).replace(",", "").strip())
        if pg == "boolean":
            if isinstance(value, bool):
                return value
            text = str(value).strip().lower()
            return True if text in _TRUE else False if text in _FALSE else None
        if pg == "date":
            if isinstance(value, datetime):
                return value.date()
            if isinstance(value, date):
                return value
            return _parse_date(str(value))
        if pg == "timestamptz":
            if isinstance(value, datetime):
                return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
            parsed = datetime.fromisoformat(str(value).strip().replace("Z", "+00:00"))
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        if pg == "jsonb":
            return json.dumps(value, default=str)
    except (ValueError, InvalidOperation, TypeError):
        return None
    return None


def _parse_date(text: str) -> Optional[date]:
    text = text.strip()
    with contextlib.suppress(ValueError):
        return date.fromisoformat(text[:10])
    for fmt in ("%d/%m/%Y", "%Y/%m/%d", "%d-%m-%Y", "%d %b %Y", "%b %d, %Y", "%m/%d/%Y"):
        with contextlib.suppress(ValueError):
            return datetime.strptime(text, fmt).date()
    return None


# ---------------------------------------------------------------------------
# Access (pure)
# ---------------------------------------------------------------------------


def _is_profile_admin(principal: Any) -> bool:
    return bool(getattr(principal, "is_owner", False)) or getattr(principal, "role", None) in (
        "owner",
        "admin",
    )


def access_level(site: "Site", principal: Any, grant: Optional[str]) -> Optional[str]:
    """``admin`` | ``read`` | ``None`` (may not know the site exists).

    The profile's owner and admins manage every site; the site's owner is an
    implicit admin; everyone else needs a live grant.
    """
    if principal is None:
        return None
    if _is_profile_admin(principal):
        return "admin"
    if site.owner_user_id and site.owner_user_id == getattr(principal, "user_id", None):
        return "admin"
    if grant in GRANTS:
        return grant
    return None


def create_roles(config: Mapping[str, Any]) -> List[str]:
    """``sites.create_roles`` from config, owner always included."""
    from hermes_cli.access import ROLES

    section = config.get("sites") if isinstance(config, Mapping) else None
    raw = section.get("create_roles") if isinstance(section, Mapping) else None
    if not isinstance(raw, list):
        raw = list(DEFAULT_CREATE_ROLES)
    roles: List[str] = [r for r in ROLES if r in raw]
    if "owner" not in roles:
        roles.insert(0, "owner")
    return roles


def set_create_roles(config: Dict[str, Any], value: Any) -> List[str]:
    from hermes_cli.access import ROLES

    if not isinstance(value, list) or any(r not in ROLES for r in value):
        raise SiteError("create_roles must be a list of: " + ", ".join(ROLES))
    roles: List[str] = [r for r in ROLES if r in value or r == "owner"]
    section = config.get("sites")
    if not isinstance(section, dict):
        section = config["sites"] = {}
    section["create_roles"] = roles
    return roles


def can_create(principal: Any, config: Mapping[str, Any]) -> bool:
    if principal is None:
        return False
    if getattr(principal, "is_owner", False):
        return True
    return getattr(principal, "role", None) in create_roles(config)


# ---------------------------------------------------------------------------
# Database access
# ---------------------------------------------------------------------------


REGISTRY_SQL = """
CREATE TABLE IF NOT EXISTS public.site_sources (
    id uuid PRIMARY KEY,
    slug text NOT NULL UNIQUE,
    name text NOT NULL,
    base_url text NOT NULL,
    login_url text,
    credential_ref text,
    owner_user_id text NOT NULL,
    profile text NOT NULL DEFAULT 'default',
    status text NOT NULL DEFAULT 'draft' CHECK (status IN
        ('draft', 'studying', 'awaiting_approval', 'active', 'paused', 'error')),
    schema_name text NOT NULL,
    db_role text NOT NULL,
    schedule_cron text,
    default_refresh_mode text NOT NULL DEFAULT 'incremental'
        CHECK (default_refresh_mode IN ('incremental', 'full')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS site_sources_profile_idx ON public.site_sources (profile);
CREATE TABLE IF NOT EXISTS public.site_source_grants (
    site_id uuid NOT NULL REFERENCES public.site_sources (id) ON DELETE CASCADE,
    user_id text NOT NULL,
    "grant" text NOT NULL CHECK ("grant" IN ('read', 'admin')),
    granted_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS site_source_grants_live
    ON public.site_source_grants (site_id, user_id) WHERE revoked_at IS NULL;
REVOKE ALL ON public.site_sources, public.site_source_grants FROM PUBLIC;
"""

_SITE_COLUMNS = (
    "id, slug, name, base_url, login_url, credential_ref, owner_user_id, profile, "
    "status, schema_name, db_role, schedule_cron, default_refresh_mode, created_at, updated_at"
)
_EDITABLE = ("name", "base_url", "login_url", "status", "schedule_cron", "default_refresh_mode")


@dataclass
class Site:
    id: str
    slug: str
    name: str
    base_url: str
    owner_user_id: str
    profile: str = "default"
    login_url: Optional[str] = None
    credential_ref: Optional[str] = None
    status: str = "draft"
    schema_name: str = ""
    db_role: str = ""
    schedule_cron: Optional[str] = None
    default_refresh_mode: str = "incremental"
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    @property
    def reader_role(self) -> str:
        return reader_role(self.slug)

    @property
    def writer_role(self) -> str:
        return writer_role(self.slug)

    def view(self, access: Optional[str] = None) -> Dict[str, Any]:
        out = {
            "id": self.id,
            "slug": self.slug,
            "name": self.name,
            "base_url": self.base_url,
            "login_url": self.login_url,
            "login_saved": bool(self.credential_ref),
            "owner_user_id": self.owner_user_id,
            "profile": self.profile,
            "status": self.status,
            "schema_name": self.schema_name,
            "schedule_cron": self.schedule_cron,
            "default_refresh_mode": self.default_refresh_mode,
            "created_at": _iso(self.created_at),
            "updated_at": _iso(self.updated_at),
        }
        if access is not None:
            out["access"] = access
        return out


def _iso(value: Any) -> Any:
    return value.isoformat() if isinstance(value, (datetime, date)) else value


def jsonable(value: Any) -> Any:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        return None
    if isinstance(value, dict):
        return {k: jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [jsonable(v) for v in value]
    return value


def _row_to_site(row: Mapping[str, Any]) -> Site:
    return Site(
        id=str(row["id"]),
        slug=row["slug"],
        name=row["name"],
        base_url=row["base_url"],
        owner_user_id=row["owner_user_id"],
        profile=row["profile"],
        login_url=row["login_url"],
        credential_ref=row["credential_ref"],
        status=row["status"],
        schema_name=row["schema_name"],
        db_role=row["db_role"],
        schedule_cron=row["schedule_cron"],
        default_refresh_mode=row["default_refresh_mode"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _json_in(value: Any) -> Any:
    if isinstance(value, str):
        try:
            return json.loads(value)
        except ValueError:
            return value
    return value


def _role_secrets_path() -> Path:
    from hermes_constants import get_default_hermes_root

    return get_default_hermes_root() / "site-sources" / "roles.json"


def _read_role_secrets() -> Dict[str, str]:
    path = _role_secrets_path()
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    return {str(k): str(v) for k, v in data.items()} if isinstance(data, dict) else {}


def _role_password(role: str, *, create: bool) -> Optional[str]:
    """The stored password of a site role (0600 file at the box root)."""
    current = _read_role_secrets()
    if role in current or not create:
        return current.get(role)
    path = _role_secrets_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    current[role] = secrets.token_urlsafe(32)
    tmp = path.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        json.dump(current, fh)
    os.replace(tmp, path)
    return current[role]


def role_dsn(dsn: str, role: str, password: str) -> str:
    """``dsn`` with its login swapped for ``role``.

    A Supavisor login (``postgres.<tenant>``) keeps its tenant suffix.
    """
    parts = urlsplit(dsn)
    user = unquote(parts.username or "")
    login = f"{role}.{user.split('.', 1)[1]}" if "." in user else role
    host = parts.hostname or "localhost"
    if ":" in host:
        host = f"[{host}]"
    netloc = f"{quote(login, safe='')}:{quote(password, safe='')}@{host}"
    if parts.port:
        netloc += f":{parts.port}"
    return urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment))


class SiteDatabase:
    """Connections for the site feature.

    ``privileged()`` is the app-store login (DDL, registry). ``restricted()``
    logs in as one site's own role, pinned to its schema.
    """

    def __init__(self, dsn: Optional[str] = None) -> None:
        self._dsn = dsn

    def _app_store(self) -> Any:
        from hermes_cli.config import load_config_readonly
        from hermes_cli.datastore import get_store

        return get_store("supabase-app", "prod", config=load_config_readonly() or {})

    @property
    def dsn(self) -> str:
        if self._dsn is not None:
            return self._dsn
        return str(self._app_store().dsn or "")

    def configured(self) -> bool:
        dsn = self.dsn
        return bool(dsn) and not dsn.lstrip().startswith("${")

    async def privileged(self) -> Any:
        if not self.configured():
            raise SiteError("the app database is not configured on this install", 503)
        if self._dsn is not None:
            import asyncpg

            return await asyncpg.connect(self._dsn)
        return await self._app_store().connect()

    async def restricted(self, site: Site, *, write: bool = False) -> Any:
        import asyncpg

        role = site.writer_role if write else site.reader_role
        password = _role_password(role, create=False)
        if not password:
            raise SiteError(f"site {site.slug!r} has not been provisioned on this box", 409)
        settings = {
            "search_path": site.schema_name,
            "statement_timeout": str(QUERY_TIMEOUT_MS if not write else 0),
            "application_name": f"hermes-site-{'rw' if write else 'ro'}",
        }
        if not write:
            settings["default_transaction_read_only"] = "on"
        conn = await asyncpg.connect(role_dsn(self.dsn, role, password), server_settings=settings)
        await conn.set_type_codec(
            "jsonb", encoder=json.dumps, decoder=json.loads, schema="pg_catalog"
        )
        return conn


_database: Optional[SiteDatabase] = None


def database() -> SiteDatabase:
    """The process-wide :class:`SiteDatabase` (tests replace it)."""
    global _database
    if _database is None:
        _database = SiteDatabase()
    return _database


def set_database(db: Optional[SiteDatabase]) -> None:
    global _database
    _database = db


_registry_ready: Set[str] = set()


async def _ensure_registry(conn: Any, db: SiteDatabase) -> None:
    key = db.dsn
    if key in _registry_ready:
        return
    await conn.execute(REGISTRY_SQL)
    _registry_ready.add(key)


@contextlib.asynccontextmanager
async def _admin(db: Optional[SiteDatabase] = None):
    db = db or database()
    conn = await db.privileged()
    try:
        await _ensure_registry(conn, db)
        yield conn
    finally:
        await conn.close()


@contextlib.asynccontextmanager
async def _reader(site: Site, db: Optional[SiteDatabase] = None):
    conn = await (db or database()).restricted(site, write=False)
    try:
        yield conn
    finally:
        await conn.close()


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------


def current_profile() -> str:
    from hermes_cli.profiles import get_active_profile_name

    return get_active_profile_name()


async def list_sites(*, profile: Optional[str] = None, db: Optional[SiteDatabase] = None) -> List[Site]:
    """Every site of ``profile`` (``None`` = every profile)."""
    async with _admin(db) as conn:
        if profile is None:
            rows = await conn.fetch(f"SELECT {_SITE_COLUMNS} FROM public.site_sources ORDER BY name")
        else:
            rows = await conn.fetch(
                f"SELECT {_SITE_COLUMNS} FROM public.site_sources WHERE profile = $1 ORDER BY name",
                profile,
            )
    return [_row_to_site(r) for r in rows]


async def get_site(site_id: str, *, db: Optional[SiteDatabase] = None) -> Optional[Site]:
    from hermes_cli.access import is_uuid

    if not is_uuid(site_id):
        return None
    async with _admin(db) as conn:
        row = await conn.fetchrow(
            f"SELECT {_SITE_COLUMNS} FROM public.site_sources WHERE id = $1::uuid", str(site_id)
        )
    return _row_to_site(row) if row else None


async def find_site(ref: str, *, profile: str, db: Optional[SiteDatabase] = None) -> Optional[Site]:
    """A site of ``profile`` by id or slug."""
    from hermes_cli.access import is_uuid

    if is_uuid(ref):
        site = await get_site(ref, db=db)
        return site if site and site.profile == profile else None
    async with _admin(db) as conn:
        row = await conn.fetchrow(
            f"SELECT {_SITE_COLUMNS} FROM public.site_sources WHERE slug = $1 AND profile = $2",
            str(ref or "").strip().lower(),
            profile,
        )
    return _row_to_site(row) if row else None


async def grants_of(user_id: str, *, db: Optional[SiteDatabase] = None) -> Dict[str, str]:
    """``{site_id: grant}`` of every live grant ``user_id`` holds."""
    async with _admin(db) as conn:
        rows = await conn.fetch(
            'SELECT site_id, "grant" FROM public.site_source_grants '
            "WHERE user_id = $1 AND revoked_at IS NULL",
            user_id,
        )
    return {str(r["site_id"]): r["grant"] for r in rows}


async def grant_for(site_id: str, user_id: str, *, db: Optional[SiteDatabase] = None) -> Optional[str]:
    async with _admin(db) as conn:
        return await conn.fetchval(
            'SELECT "grant" FROM public.site_source_grants '
            "WHERE site_id = $1::uuid AND user_id = $2 AND revoked_at IS NULL",
            site_id,
            user_id,
        )


async def list_grants(site_id: str, *, db: Optional[SiteDatabase] = None) -> List[Dict[str, Any]]:
    async with _admin(db) as conn:
        rows = await conn.fetch(
            'SELECT user_id, "grant", granted_by, created_at FROM public.site_source_grants '
            "WHERE site_id = $1::uuid AND revoked_at IS NULL ORDER BY created_at",
            site_id,
        )
    return [jsonable(dict(r)) for r in rows]


async def put_grant(
    site_id: str, user_id: str, grant: str, *, by: str, db: Optional[SiteDatabase] = None
) -> Dict[str, Any]:
    if grant not in GRANTS:
        raise SiteError("grant must be read or admin")
    user_id = str(user_id or "").strip()
    if not user_id:
        raise SiteError("user_id is required")
    async with _admin(db) as conn:
        async with conn.transaction():
            await conn.execute(
                "UPDATE public.site_source_grants SET revoked_at = now() "
                "WHERE site_id = $1::uuid AND user_id = $2 AND revoked_at IS NULL",
                site_id,
                user_id,
            )
            await conn.execute(
                'INSERT INTO public.site_source_grants (site_id, user_id, "grant", granted_by) '
                "VALUES ($1::uuid, $2, $3, $4)",
                site_id,
                user_id,
                grant,
                by,
            )
    return {"user_id": user_id, "grant": grant, "granted_by": by}


async def revoke_grant(site_id: str, user_id: str, *, db: Optional[SiteDatabase] = None) -> bool:
    async with _admin(db) as conn:
        result = await conn.execute(
            "UPDATE public.site_source_grants SET revoked_at = now() "
            "WHERE site_id = $1::uuid AND user_id = $2 AND revoked_at IS NULL",
            site_id,
            str(user_id or ""),
        )
    return not result.endswith(" 0")


def _clean_url(value: Any, field_name: str, *, required: bool) -> Optional[str]:
    text = str(value or "").strip()
    if not text:
        if required:
            raise SiteError(f"{field_name} is required")
        return None
    parts = urlsplit(text)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise SiteError(f"{field_name} must be an http(s) URL")
    return text


def _clean_fields(body: Mapping[str, Any], *, creating: bool) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    if "name" in body or creating:
        name = re.sub(r"\s+", " ", str(body.get("name") or "")).strip()
        if not name or len(name) > 120:
            raise SiteError("name is required (up to 120 characters)")
        out["name"] = name
    if "base_url" in body or creating:
        out["base_url"] = _clean_url(body.get("base_url"), "base_url", required=True)
    if "login_url" in body:
        out["login_url"] = _clean_url(body.get("login_url"), "login_url", required=False)
    if "schedule_cron" in body:
        out["schedule_cron"] = validate_cron(body.get("schedule_cron"))
    if "default_refresh_mode" in body:
        mode = body.get("default_refresh_mode")
        if mode not in REFRESH_MODES:
            raise SiteError("default_refresh_mode must be incremental or full")
        out["default_refresh_mode"] = mode
    if "status" in body:
        status = body.get("status")
        if status not in STATUSES:
            raise SiteError("status must be one of " + ", ".join(STATUSES))
        out["status"] = status
    return out


async def create_site(
    principal: Any,
    body: Mapping[str, Any],
    *,
    profile: Optional[str] = None,
    db: Optional[SiteDatabase] = None,
) -> Site:
    """Register a site, provision its schema and roles, save its login."""
    fields = _clean_fields(body, creating=True)
    slug = normalize_slug(body.get("slug") or fields["name"])
    site = Site(
        id=str(uuid.uuid4()),
        slug=slug,
        name=fields["name"],
        base_url=fields["base_url"],
        login_url=fields.get("login_url"),
        owner_user_id=principal.user_id,
        profile=profile or current_profile(),
        schedule_cron=fields.get("schedule_cron"),
        default_refresh_mode=fields.get("default_refresh_mode", "incremental"),
        schema_name=schema_name(slug),
        db_role=writer_role(slug),
    )
    async with _admin(db) as conn:
        taken = await conn.fetchval(
            "SELECT 1 FROM public.site_sources WHERE slug = $1 "
            "UNION ALL SELECT 1 FROM pg_namespace WHERE nspname = $2 LIMIT 1",
            slug,
            site.schema_name,
        )
        if taken:
            raise SiteError(f"a site called {slug!r} already exists; choose another name", 409)
        await conn.execute(
            "INSERT INTO public.site_sources (id, slug, name, base_url, login_url, owner_user_id, "
            "profile, status, schema_name, db_role, schedule_cron, default_refresh_mode) "
            "VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, 'draft', $8, $9, $10, $11)",
            site.id,
            site.slug,
            site.name,
            site.base_url,
            site.login_url,
            site.owner_user_id,
            site.profile,
            site.schema_name,
            site.db_role,
            site.schedule_cron,
            site.default_refresh_mode,
        )
        try:
            await provision_schema(site, connection=conn)
        except BaseException:
            await conn.execute("DELETE FROM public.site_sources WHERE id = $1::uuid", site.id)
            raise
    if body.get("username") or body.get("password"):
        await save_login(principal, site, body, db=db)
    return await get_site(site.id, db=db) or site


async def update_site(
    site: Site, body: Mapping[str, Any], *, principal: Any = None, db: Optional[SiteDatabase] = None
) -> Site:
    fields = _clean_fields(body, creating=False)
    if fields:
        sets = ", ".join(f"{name} = ${i + 2}" for i, name in enumerate(fields))
        async with _admin(db) as conn:
            await conn.execute(
                f"UPDATE public.site_sources SET {sets}, updated_at = now() WHERE id = $1::uuid",
                site.id,
                *fields.values(),
            )
    if principal is not None and (body.get("username") or body.get("password")):
        await save_login(principal, site, body, db=db)
    return await get_site(site.id, db=db) or site


async def set_status(site: Site, status: str, *, db: Optional[SiteDatabase] = None) -> None:
    if status not in STATUSES:
        raise SiteError(f"unknown status {status!r}")
    async with _admin(db) as conn:
        await conn.execute(
            "UPDATE public.site_sources SET status = $2, updated_at = now() WHERE id = $1::uuid",
            site.id,
            status,
        )
    site.status = status


# ---------------------------------------------------------------------------
# Saved site login (credential store, D10)
# ---------------------------------------------------------------------------


async def save_login(
    principal: Any, site: Site, body: Mapping[str, Any], *, db: Optional[SiteDatabase] = None
) -> str:
    """Store the site's login under the *site owner* (private to them).

    Only the owner's entry is used by refreshes, so a site admin who is not the
    owner cannot swap the login the owner's schedule runs with.
    """
    from hermes_cli.credential_store import (
        CredentialError,
        default_credential_store,
        merge_kept_secrets,
    )

    if getattr(principal, "user_id", None) != site.owner_user_id:
        raise SiteError("only the site's owner can change its saved login", 403)
    store = default_credential_store()
    existing = await store.get(principal, CREDENTIAL_PROVIDER, site.slug)
    payload: Dict[str, Any] = {}
    for key in ("username", "password"):
        value = body.get(key)
        if isinstance(value, str) and value:
            payload[key] = value
    if existing is not None and "username" not in payload:
        payload["username"] = existing.payload.get("username", "")
    login_url = body.get("login_url") or site.login_url
    if login_url:
        payload["login_url"] = str(login_url)
    payload = merge_kept_secrets(CREDENTIAL_KIND, payload, existing.payload if existing else None)
    if not payload.get("username") or not payload.get("password"):
        raise SiteError("both username and password are needed to save a site login")
    try:
        await store.put(
            principal,
            provider=CREDENTIAL_PROVIDER,
            name=site.slug,
            kind=CREDENTIAL_KIND,
            payload=payload,
            visibility=principal.private_visibility,
        )
    except CredentialError as exc:
        raise SiteError(str(exc).replace(payload["password"], "***")) from exc
    ref = f"{CREDENTIAL_PROVIDER}/{site.slug}"
    async with _admin(db) as conn:
        await conn.execute(
            "UPDATE public.site_sources SET credential_ref = $2, updated_at = now() WHERE id = $1::uuid",
            site.id,
            ref,
        )
    site.credential_ref = ref
    return ref


async def load_login(site: Site) -> Optional[Dict[str, Any]]:
    """The owner's saved login for ``site`` (full payload; in-process only)."""
    if not site.credential_ref:
        return None
    from hermes_cli.access import Principal
    from hermes_cli.credential_store import default_credential_store

    owner = Principal(user_id=site.owner_user_id, display=site.owner_user_id, role="member")
    cred = await default_credential_store().get(owner, CREDENTIAL_PROVIDER, site.slug)
    if cred is None or cred.owner_user_id != site.owner_user_id:
        return None
    payload = dict(cred.payload)
    payload.setdefault("login_url", site.login_url or site.base_url)
    return payload


# ---------------------------------------------------------------------------
# Provisioning + designs
# ---------------------------------------------------------------------------


async def _ensure_login_role(conn: Any, role: str) -> None:
    from hermes_cli.access import _quote_literal

    password = _role_password(role, create=True) or ""
    literal = _quote_literal(password)
    exists = await conn.fetchval("SELECT 1 FROM pg_roles WHERE rolname = $1", role)
    if exists:
        await conn.execute(f"ALTER ROLE {role} PASSWORD {literal}")
    else:
        await conn.execute(
            f"CREATE ROLE {role} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE "
            f"NOINHERIT PASSWORD {literal}"
        )
    current_db = await conn.fetchval("SELECT current_database()")
    await conn.execute(f'GRANT CONNECT ON DATABASE "{current_db}" TO {role}')


async def _grant_roles(conn: Any, site: Site) -> None:
    for statement in role_grant_sql(site.schema_name, rw=site.writer_role, ro=site.reader_role):
        await conn.execute(statement)


async def provision_schema(site: Site, *, connection: Any = None, db: Optional[SiteDatabase] = None) -> None:
    """Create ``site_<slug>``, its fixed tables and its two roles (idempotent)."""

    async def _run(conn: Any) -> None:
        async with conn.transaction():
            for statement in meta_ddl(site.schema_name):
                await conn.execute(statement)
            await conn.execute(
                f"INSERT INTO {_ident(site.schema_name)}._meta (key, value) VALUES "
                "('site_id', to_jsonb($1::text)) ON CONFLICT (key) DO NOTHING",
                site.id,
            )
        await _ensure_login_role(conn, site.writer_role)
        await _ensure_login_role(conn, site.reader_role)
        await _grant_roles(conn, site)

    if connection is not None:
        await _run(connection)
        return
    async with _admin(db) as conn:
        await _run(conn)


async def existing_columns(conn: Any, schema: str) -> Dict[str, Dict[str, str]]:
    rows = await conn.fetch(
        "SELECT table_name, column_name, data_type FROM information_schema.columns "
        "WHERE table_schema = $1",
        schema,
    )
    out: Dict[str, Dict[str, str]] = {}
    for row in rows:
        out.setdefault(row["table_name"], {})[row["column_name"]] = _PG_DATA_TYPES.get(
            row["data_type"], row["data_type"]
        )
    return out


async def propose_design(
    site: Site,
    design: Any,
    recipe: Any,
    *,
    by: str,
    db: Optional[SiteDatabase] = None,
) -> Dict[str, Any]:
    """Store a new design version for approval; nothing is created yet (D6)."""
    design = validate_design(design)
    recipe = check_recipe(recipe) if recipe is not None else None
    s = _ident(site.schema_name)
    async with _admin(db) as conn:
        design_ddl(site.schema_name, design, await existing_columns(conn, site.schema_name))
        async with conn.transaction():
            version = await conn.fetchval(f"SELECT coalesce(max(version), 0) + 1 FROM {s}._designs")
            design["version"] = version
            design.setdefault("site", site.slug)
            await conn.execute(
                f"INSERT INTO {s}._designs (version, design, recipe, status, proposed_by) "
                "VALUES ($1, $2::jsonb, $3::jsonb, 'proposed', $4)",
                version,
                json.dumps(design),
                json.dumps(recipe) if recipe is not None else None,
                by,
            )
            await conn.execute(
                "UPDATE public.site_sources SET status = 'awaiting_approval', updated_at = now() "
                "WHERE id = $1::uuid AND status IN ('draft', 'studying', 'awaiting_approval', 'error')",
                site.id,
            )
    questions = [
        {"entity": e["name"], "question": e["question"]} for e in design["entities"] if e.get("question")
    ]
    return {"version": version, "status": "proposed", "questions": questions}


async def list_designs(site: Site, *, db: Optional[SiteDatabase] = None) -> List[Dict[str, Any]]:
    s = _ident(site.schema_name)
    async with _admin(db) as conn:
        rows = await conn.fetch(
            f"SELECT version, design, recipe, status, proposed_by, proposed_at, approved_by, "
            f"approved_at FROM {s}._designs ORDER BY version DESC"
        )
    out = []
    for row in rows:
        item = jsonable(dict(row))
        item["design"] = _json_in(row["design"])
        item["recipe"] = _json_in(row["recipe"])
        out.append(item)
    return out


async def approved_design(
    site: Site, *, db: Optional[SiteDatabase] = None
) -> Optional[Tuple[int, Dict[str, Any], Optional[Dict[str, Any]]]]:
    s = _ident(site.schema_name)
    async with _admin(db) as conn:
        row = await conn.fetchrow(
            f"SELECT version, design, recipe FROM {s}._designs WHERE status = 'approved' "
            "ORDER BY version DESC LIMIT 1"
        )
    if row is None:
        return None
    return row["version"], _json_in(row["design"]), _json_in(row["recipe"])


async def apply_design(
    site: Site, version: int, *, approved_by: str, db: Optional[SiteDatabase] = None
) -> Dict[str, Any]:
    """Approve design ``version`` and create/extend its tables (additive only)."""
    s = _ident(site.schema_name)
    async with _admin(db) as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                f"SELECT design, status FROM {s}._designs WHERE version = $1 FOR UPDATE", int(version)
            )
            if row is None:
                raise SiteError(f"no design version {version}", 404)
            if row["status"] == "superseded":
                raise SiteError(f"design version {version} was superseded by a later one", 409)
            design = validate_design(_json_in(row["design"]))
            statements = design_ddl(
                site.schema_name, design, await existing_columns(conn, site.schema_name)
            )
            for statement in statements:
                await conn.execute(statement)
            await conn.execute(
                f"UPDATE {s}._designs SET status = 'superseded' "
                "WHERE status = 'approved' AND version <> $1",
                int(version),
            )
            await conn.execute(
                f"UPDATE {s}._designs SET status = 'approved', approved_by = $2, approved_at = now() "
                "WHERE version = $1 AND status <> 'approved'",
                int(version),
                approved_by,
            )
            await conn.execute(
                f"INSERT INTO {s}._meta (key, value) VALUES ('design_version', to_jsonb($1::int)) "
                "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
                int(version),
            )
            await conn.execute(
                "UPDATE public.site_sources SET status = 'active', updated_at = now() "
                "WHERE id = $1::uuid AND status <> 'paused'",
                site.id,
            )
        await _grant_roles(conn, site)
    return {"version": int(version), "status": "approved", "statements": statements}


# ---------------------------------------------------------------------------
# Writer (§3.5)
# ---------------------------------------------------------------------------


@dataclass
class SiteRun:
    id: str
    mode: str
    trigger: str
    pages: int = 0
    inserted: int = 0
    updated: int = 0
    removed: int = 0
    versions: int = 0
    restored: int = 0
    failed: int = 0
    seen: Dict[str, Set[str]] = field(default_factory=dict)
    entity_modes: Dict[str, str] = field(default_factory=dict)
    errors: List[str] = field(default_factory=list)
    status: str = "running"
    #: Entities whose extraction or storage failed this run ("*" = unknown).
    failed_entities: Set[str] = field(default_factory=set)
    #: The runner's RunReport (merged over the run's mode groups).
    report: Dict[str, Any] = field(default_factory=dict)

    def view(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "mode": self.mode,
            "trigger": self.trigger,
            "status": self.status,
            "pages": self.pages,
            "inserted": self.inserted,
            "updated": self.updated,
            "removed": self.removed,
            "versions": self.versions,
        }


class SiteWriter:
    """Store extracted records for one site under its ``_rw`` role.

    ``begin_run`` -> any number of ``upsert`` / ``record_fixed`` ->
    ``finish_run``. Removal of unseen content happens only in ``finish_run``,
    only for the entities named in ``full_entities`` and only when the run
    ended cleanly — an incremental or failed run never removes anything.
    """

    def __init__(self, site: Site, design: Mapping[str, Any], connection: Any) -> None:
        self.site = site
        self.design = validate_design(design)
        self.conn = connection
        self.entities = {e["name"]: e for e in self.design["entities"]}
        self.run: Optional[SiteRun] = None

    def _entity(self, name: str, kind: str) -> Mapping[str, Any]:
        entity = self.entities.get(name)
        if entity is None:
            raise SiteError(f"{name!r} is not an entity of the approved design")
        if entity["kind"] != kind:
            raise SiteError(f"{name!r} is {entity['kind']} content, not {kind}")
        return entity

    def _need_run(self) -> SiteRun:
        if self.run is None:
            raise SiteError("begin_run first")
        return self.run

    async def begin_run(self, mode: str, trigger: str) -> SiteRun:
        if mode not in REFRESH_MODES:
            raise SiteError("mode must be incremental or full")
        if trigger not in TRIGGERS:
            raise SiteError("trigger must be manual, schedule or agent")
        run = SiteRun(id=str(uuid.uuid4()), mode=mode, trigger=trigger)
        await self.conn.execute(
            "INSERT INTO _runs (id, mode, trigger) VALUES ($1::uuid, $2, $3)", run.id, mode, trigger
        )
        self.run = run
        return run

    async def _change(self, entity: str, key: str, op: str, before: Any, after: Any) -> None:
        await self.conn.execute(
            "INSERT INTO _changes (entity, key, run_id, op, before, after) "
            "VALUES ($1, $2, $3::uuid, $4, $5, $6)",
            entity,
            key,
            self._need_run().id,
            op,
            before,
            after,
        )

    async def upsert(self, entity: str, records: Iterable[Any]) -> Dict[str, int]:
        """Insert, update or restore variable ``entity`` rows by key."""
        run = self._need_run()
        spec = self._entity(entity, "variable")
        table = _ident(entity)
        cols = [(c["name"], c["type"]) for c in spec["columns"]]
        col_sql = "".join(f", {_ident(n)}" for n, _ in cols)
        counts = {"inserted": 0, "updated": 0, "restored": 0, "unchanged": 0}
        seen = run.seen.setdefault(entity, set())
        async with self.conn.transaction():
            for record in records:
                key, payload = _split_record(spec, record)
                new_hash = content_hash(payload)
                values = [coerce(payload.get(n), t) for n, t in cols]
                existing = await self.conn.fetchrow(
                    f"SELECT _hash, _payload, _removed_at FROM {table} WHERE _key = $1 FOR UPDATE", key
                )
                seen.add(key)
                op = decide_upsert(dict(existing) if existing else None, new_hash)
                if op is None:
                    await self.conn.execute(
                        f"UPDATE {table} SET _last_seen = now(), _run_id = $2::uuid WHERE _key = $1",
                        key,
                        run.id,
                    )
                    counts["unchanged"] += 1
                    continue
                casts = "".join(f", ${i + 5}::{COLUMN_TYPES[t]}" for i, (_, t) in enumerate(cols))
                if op == "insert":
                    await self.conn.execute(
                        f"INSERT INTO {table} (_key, _hash, _payload, _run_id{col_sql}) "
                        f"VALUES ($1, $2, $3, $4::uuid{casts})",
                        key,
                        new_hash,
                        payload,
                        run.id,
                        *values,
                    )
                    run.inserted += 1
                    counts["inserted"] += 1
                    await self._change(entity, key, "insert", None, payload)
                    continue
                sets = "".join(f", {_ident(n)} = ${i + 5}::{COLUMN_TYPES[t]}" for i, (n, t) in enumerate(cols))
                await self.conn.execute(
                    f"UPDATE {table} SET _hash = $2, _payload = $3, _run_id = $4::uuid, "
                    f"_last_seen = now(), _removed_at = NULL{sets} WHERE _key = $1",
                    key,
                    new_hash,
                    payload,
                    run.id,
                    *values,
                )
                if op == "restore":
                    run.restored += 1
                    counts["restored"] += 1
                else:
                    counts["updated"] += 1
                run.updated += 1
                await self._change(entity, key, op, existing["_payload"], payload)
        return counts

    async def record_fixed(self, entity: str, key: Optional[str], payload: Mapping[str, Any]) -> Optional[str]:
        """Version fixed content: a new version only when it changed."""
        run = self._need_run()
        spec = self._entity(entity, "fixed")
        payload = dict(payload)
        key = str(key) if key not in (None, "") else record_key(spec, payload)
        new_hash = content_hash(payload)
        run.seen.setdefault(entity, set()).add(key)
        async with self.conn.transaction():
            latest = await self.conn.fetchrow(
                "SELECT version, content_hash, payload, valid_to FROM _fixed_versions "
                "WHERE entity = $1 AND content_key = $2 ORDER BY version DESC LIMIT 1 FOR UPDATE",
                entity,
                key,
            )
            op = decide_fixed(dict(latest) if latest else None, new_hash)
            if op is None:
                return None
            if latest is not None and latest["valid_to"] is None:
                await self.conn.execute(
                    "UPDATE _fixed_versions SET valid_to = now() "
                    "WHERE entity = $1 AND content_key = $2 AND version = $3",
                    entity,
                    key,
                    latest["version"],
                )
            version = (latest["version"] if latest else 0) + 1
            await self.conn.execute(
                "INSERT INTO _fixed_versions (entity, content_key, version, content_hash, payload, run_id) "
                "VALUES ($1, $2, $3, $4, $5, $6::uuid)",
                entity,
                key,
                version,
                new_hash,
                payload,
                run.id,
            )
            run.versions += 1
            await self._change(entity, key, op, latest["payload"] if latest else None, payload)
        return op

    def add_pages(self, count: int = 1) -> None:
        self._need_run().pages += int(count)

    async def finish_run(
        self,
        run: Optional[SiteRun] = None,
        full_entities: Sequence[str] = (),
        *,
        error: Optional[str] = None,
        cursors: Optional[Mapping[str, Any]] = None,
    ) -> SiteRun:
        """Close the run; mark unseen content removed for clean full refreshes.

        Removal happens only when the run did not fail as a whole, only for
        the entities in ``full_entities`` and never for an entity that failed
        (or when a failure could not be tied to an entity). ``cursors`` are
        the runner's next cursors, kept for entities that did not fail.
        """
        run = run or self._need_run()
        if error:
            run.status = "error"
        elif run.failed or run.errors or run.failed_entities:
            run.status = "partial"
        else:
            run.status = "ok"
        removed_for: List[str] = []
        if run.status != "error" and "*" not in run.failed_entities:
            for name in dict.fromkeys(full_entities):
                spec = self.entities.get(name)
                if spec is None or name in run.failed_entities:
                    continue
                run.removed += await self._remove_unseen(spec, run)
                removed_for.append(name)
        if cursors and run.status != "error":
            keep = {
                n: jsonable(v)
                for n, v in cursors.items()
                if n in self.entities and n not in run.failed_entities and v is not None
            }
            if keep:
                await self.conn.execute(
                    "INSERT INTO _meta (key, value) VALUES ('cursors', $1) "
                    "ON CONFLICT (key) DO UPDATE SET value = COALESCE(_meta.value, '{}'::jsonb) || EXCLUDED.value",
                    keep,
                )
        detail = {
            "entity_modes": run.entity_modes,
            "full_entities": removed_for,
            "restored": run.restored,
            "failed": run.failed,
            "failed_entities": sorted(run.failed_entities),
            "errors": run.errors[:20],
        }
        if run.report:
            detail["report"] = run.report
        await self.conn.execute(
            "UPDATE _runs SET finished_at = now(), status = $2, pages = $3, inserted = $4, "
            "updated = $5, removed = $6, versions = $7, error = $8, detail = $9 WHERE id = $1::uuid",
            run.id,
            run.status,
            run.pages,
            run.inserted,
            run.updated,
            run.removed,
            run.versions,
            (error or "\n".join(run.errors[:5]) or None),
            detail,
        )
        return run

    async def _remove_unseen(self, spec: Mapping[str, Any], run: SiteRun) -> int:
        seen = sorted(run.seen.get(spec["name"], set()))
        name = spec["name"]
        async with self.conn.transaction():
            if spec["kind"] == "variable":
                rows = await self.conn.fetch(
                    f"UPDATE {_ident(name)} SET _removed_at = now() "
                    "WHERE _removed_at IS NULL AND NOT (_key = ANY($1::text[])) RETURNING _key, _payload",
                    seen,
                )
                for row in rows:
                    await self._change(name, row["_key"], "remove", row["_payload"], None)
                return len(rows)
            rows = await self.conn.fetch(
                "UPDATE _fixed_versions SET valid_to = now() WHERE entity = $1 AND valid_to IS NULL "
                "AND NOT (content_key = ANY($2::text[])) RETURNING content_key, payload",
                name,
                seen,
            )
            for row in rows:
                await self._change(name, row["content_key"], "remove", row["payload"], None)
            return len(rows)


def _split_record(spec: Mapping[str, Any], record: Any) -> Tuple[str, Dict[str, Any]]:
    if isinstance(record, tuple) and len(record) == 2 and isinstance(record[1], Mapping):
        key, payload = record
        payload = dict(payload)
        return (str(key) if key not in (None, "") else record_key(spec, payload)), payload
    if isinstance(record, Mapping):
        payload = dict(record)
        return record_key(spec, payload), payload
    raise SiteError(f"{spec['name']}: a record must be an object")


# ---------------------------------------------------------------------------
# Reads (all under the site's read-only role)
# ---------------------------------------------------------------------------


_COMMENT_RE = re.compile(r"--[^\n]*|/\*.*?\*/", re.DOTALL)


def check_select(sql: Any) -> str:
    """One ``SELECT``/``WITH`` statement, or :class:`SiteError`.

    The role and the read-only transaction are what enforce read-only; this
    only gives the agent a clear message instead of a Postgres error.
    """
    text = str(sql or "").strip().rstrip(";").strip()
    bare = _COMMENT_RE.sub(" ", text).strip()
    if not bare:
        raise SiteError("sql is required")
    if ";" in re.sub(r"'(?:[^']|'')*'", "''", bare):
        raise SiteError("one statement at a time")
    first = bare.split(None, 1)[0].lower()
    if first not in ("select", "with", "table", "values"):
        raise SiteError("only SELECT queries can run against a site's data")
    return text


async def query(
    site: Site,
    sql: str,
    params: Sequence[Any] = (),
    *,
    max_rows: int = MAX_QUERY_ROWS,
    db: Optional[SiteDatabase] = None,
) -> Dict[str, Any]:
    """Run one read-only statement as ``site_<slug>_ro`` (search_path = its schema)."""
    sql = check_select(sql)
    max_rows = max(1, min(int(max_rows or MAX_QUERY_ROWS), MAX_QUERY_ROWS))
    import asyncpg

    async with _reader(site, db) as conn:
        try:
            async with conn.transaction(readonly=True):
                stmt = await conn.prepare(sql)
                columns = [a.name for a in stmt.get_attributes()]
                cursor = await stmt.cursor(*params)
                rows = await cursor.fetch(max_rows + 1)
        except asyncpg.PostgresError as exc:
            raise SiteError(f"query failed: {exc}") from exc
    truncated = len(rows) > max_rows
    rows = rows[:max_rows]
    return {
        "columns": columns,
        "rows": [[jsonable(v) for v in r.values()] for r in rows],
        "row_count": len(rows),
        "truncated": truncated,
    }


async def table_summaries(site: Site, *, db: Optional[SiteDatabase] = None) -> List[Dict[str, Any]]:
    """The approved design's entities with row counts."""
    current = await approved_design(site, db=db)
    if current is None:
        return []
    _, design, _ = current
    out = []
    async with _reader(site, db) as conn:
        for entity in validate_design(design)["entities"]:
            if entity["kind"] == "variable":
                row = await conn.fetchrow(
                    f"SELECT count(*) FILTER (WHERE _removed_at IS NULL) AS live, "
                    f"count(*) FILTER (WHERE _removed_at IS NOT NULL) AS removed, "
                    f"max(_last_seen) AS last_seen FROM {_ident(entity['name'])}"
                )
            else:
                row = await conn.fetchrow(
                    "SELECT count(*) FILTER (WHERE valid_to IS NULL) AS live, "
                    "count(DISTINCT content_key) FILTER (WHERE valid_to IS NOT NULL) AS removed, "
                    "max(valid_from) AS last_seen FROM _fixed_versions WHERE entity = $1",
                    entity["name"],
                )
            out.append(
                {
                    "name": entity["name"],
                    "kind": entity["kind"],
                    "reason": entity.get("reason", ""),
                    "key": entity["key"],
                    "columns": entity["columns"],
                    "refresh": entity["refresh"],
                    "rows": row["live"],
                    "removed": row["removed"],
                    "last_seen": _iso(row["last_seen"]),
                }
            )
    return out


async def _entity_spec(site: Site, entity: str, db: Optional[SiteDatabase]) -> Mapping[str, Any]:
    current = await approved_design(site, db=db)
    if current is None:
        raise SiteError("this site has no approved design yet", 404)
    for spec in validate_design(current[1])["entities"]:
        if spec["name"] == entity:
            return spec
    raise SiteError(f"no table {entity!r}", 404)


def _rows_sql(spec: Mapping[str, Any], *, include_removed: bool, q: Optional[str]) -> Tuple[str, List[Any]]:
    params: List[Any] = []
    if spec["kind"] == "variable":
        cols = ", ".join(_ident(c["name"]) for c in spec["columns"])
        where = [] if include_removed else ["_removed_at IS NULL"]
        if q:
            params.append(f"%{q}%")
            where.append(f"_payload::text ILIKE ${len(params)}")
        sql = (
            f"SELECT _key{', ' + cols if cols else ''}, _first_seen, _last_seen, _removed_at "
            f"FROM {_ident(spec['name'])}"
            + (" WHERE " + " AND ".join(where) if where else "")
            + " ORDER BY _last_seen DESC, _key"
        )
        return sql, params
    params.append(spec["name"])
    where = ["entity = $1"]
    if q:
        params.append(f"%{q}%")
        where.append(f"payload::text ILIKE ${len(params)}")
    inner = (
        "SELECT DISTINCT ON (content_key) content_key AS _key, version, payload, valid_from, valid_to "
        "FROM _fixed_versions WHERE " + " AND ".join(where) + " ORDER BY content_key, version DESC"
    )
    outer = f"SELECT * FROM ({inner}) latest"
    if not include_removed:
        outer += " WHERE valid_to IS NULL"
    return outer + " ORDER BY _key", params


async def table_rows(
    site: Site,
    entity: str,
    *,
    q: Optional[str] = None,
    page: int = 1,
    page_size: int = PAGE_SIZE,
    include_removed: bool = False,
    db: Optional[SiteDatabase] = None,
) -> Dict[str, Any]:
    spec = await _entity_spec(site, entity, db)
    page = max(1, int(page or 1))
    page_size = max(1, min(int(page_size or PAGE_SIZE), MAX_QUERY_ROWS))
    sql, params = _rows_sql(spec, include_removed=include_removed, q=(q or "").strip() or None)
    async with _reader(site, db) as conn:
        total = await conn.fetchval(f"SELECT count(*) FROM ({sql}) t", *params)
        rows = await conn.fetch(
            f"{sql} LIMIT {page_size} OFFSET {(page - 1) * page_size}", *params
        )
    return {
        "entity": entity,
        "kind": spec["kind"],
        "columns": list(rows[0].keys()) if rows else _row_columns(spec),
        "rows": [jsonable(dict(r)) for r in rows],
        "page": page,
        "page_size": page_size,
        "total": total,
    }


def _row_columns(spec: Mapping[str, Any]) -> List[str]:
    if spec["kind"] == "variable":
        return ["_key", *(c["name"] for c in spec["columns"]), "_first_seen", "_last_seen", "_removed_at"]
    return ["_key", "version", "payload", "valid_from", "valid_to"]


async def export_rows(
    site: Site,
    entity: str,
    *,
    include_removed: bool = False,
    db: Optional[SiteDatabase] = None,
) -> Tuple[List[str], List[List[Any]]]:
    spec = await _entity_spec(site, entity, db)
    sql, params = _rows_sql(spec, include_removed=include_removed, q=None)
    async with _reader(site, db) as conn:
        rows = await conn.fetch(f"{sql} LIMIT {MAX_EXPORT_ROWS}", *params)
    columns = list(rows[0].keys()) if rows else _row_columns(spec)
    return columns, [[_cell(v) for v in r.values()] for r in rows]


def _cell(value: Any) -> Any:
    value = jsonable(value)
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return value


def to_csv(columns: Sequence[str], rows: Iterable[Sequence[Any]]) -> bytes:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(columns)
    for row in rows:
        writer.writerow(["" if v is None else _safe_cell(v) for v in row])
    return ("\ufeff" + buf.getvalue()).encode("utf-8")


def _safe_cell(value: Any) -> Any:
    """Neutralise spreadsheet formulas in text cells (CSV/formula injection)."""
    if isinstance(value, str) and value[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + value
    return value


def to_xlsx(columns: Sequence[str], rows: Iterable[Sequence[Any]], *, title: str) -> bytes:
    try:
        from openpyxl import Workbook
    except ImportError:
        raise SiteError("XLSX export needs openpyxl (the 'documents' extra)", 501) from None
    wb = Workbook(write_only=True)
    ws = wb.create_sheet(title=re.sub(r"[\[\]:*?/\\]", "_", title)[:31] or "data")
    ws.append(list(columns))
    for row in rows:
        ws.append([_safe_cell(v) for v in row])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


async def history(
    site: Site, entity: str, key: str, *, db: Optional[SiteDatabase] = None
) -> Dict[str, Any]:
    spec = await _entity_spec(site, entity, db)
    async with _reader(site, db) as conn:
        changes = await conn.fetch(
            "SELECT id, run_id, op, before, after, at FROM _changes "
            "WHERE entity = $1 AND key = $2 ORDER BY at, id",
            entity,
            key,
        )
        versions = []
        if spec["kind"] == "fixed":
            versions = await conn.fetch(
                "SELECT version, content_hash, payload, valid_from, valid_to, run_id "
                "FROM _fixed_versions WHERE entity = $1 AND content_key = $2 ORDER BY version",
                entity,
                key,
            )
    return {
        "entity": entity,
        "key": key,
        "kind": spec["kind"],
        "changes": [jsonable(dict(r)) for r in changes],
        "versions": [jsonable(dict(r)) for r in versions],
    }


async def list_runs(site: Site, *, limit: int = 50, db: Optional[SiteDatabase] = None) -> List[Dict[str, Any]]:
    async with _reader(site, db) as conn:
        rows = await conn.fetch(
            "SELECT id, mode, trigger, started_at, finished_at, status, pages, inserted, updated, "
            "removed, versions, error, detail FROM _runs ORDER BY started_at DESC LIMIT $1",
            max(1, min(int(limit), 500)),
        )
    return [jsonable(dict(r)) for r in rows]


# ---------------------------------------------------------------------------
# Refresh (backend, no LLM) + scheduler
# ---------------------------------------------------------------------------


def _runner_module() -> Any:
    """``hermes_cli.site_recipe_runner`` via sys.modules (an import-blocked entry raises)."""
    return importlib.import_module("hermes_cli.site_recipe_runner")


def _recipe_runner() -> Callable[..., Iterator[Any]]:
    """``site_recipe_runner.run_recipe`` (workstream B), import-guarded."""
    try:
        runner_module = _runner_module()
    except ImportError:
        raise SiteError("the site recipe runner is not installed on this box yet", 503) from None
    run_recipe = getattr(runner_module, "run_recipe", None)
    if not callable(run_recipe):
        raise SiteError("the site recipe runner has no run_recipe()", 503)
    return run_recipe


def _item_parts(item: Any) -> Tuple[str, str, Optional[str], Dict[str, Any]]:
    """``ExtractedItem = (entity, kind, key, payload)`` as tuple or attributes."""
    if hasattr(item, "entity") and hasattr(item, "payload"):
        return item.entity, getattr(item, "kind", ""), getattr(item, "key", None), dict(item.payload)
    entity, kind, key, payload = item
    return entity, kind, key, dict(payload or {})


def recipe_entity(recipe: Optional[Mapping[str, Any]], name: str) -> Mapping[str, Any]:
    """The recipe's entry for entity ``name`` (``{}`` when absent)."""
    entities = (recipe or {}).get("entities") if isinstance(recipe, Mapping) else None
    if isinstance(entities, Mapping):
        value = entities.get(name)
        return value if isinstance(value, Mapping) else {}
    if isinstance(entities, list):
        for value in entities:
            if isinstance(value, Mapping) and value.get("name") == name:
                return value
    return {}


def _new_report(run_recipe: Callable[..., Any]) -> Any:
    """A fresh ``RunReport`` when the runner accepts ``report=`` (workstream B)."""
    try:
        params = inspect.signature(run_recipe).parameters
    except (TypeError, ValueError):
        return None
    if "report" not in params:
        return None
    module = sys.modules.get(getattr(run_recipe, "__module__", "") or "")
    report_cls = getattr(module, "RunReport", None)
    return report_cls() if callable(report_cls) else None


def _report_dict(report: Any) -> Dict[str, Any]:
    if hasattr(report, "as_dict"):
        data = report.as_dict()
    else:
        data = dict(vars(report))
    return jsonable(data) if isinstance(data, dict) else {}


def _merge_report(into: Dict[str, Any], data: Mapping[str, Any]) -> None:
    into["pages"] = int(into.get("pages") or 0) + int(data.get("pages") or 0)
    for key in ("rows",):
        merged = dict(into.get(key) or {})
        for name, count in (data.get(key) or {}).items():
            merged[name] = int(merged.get(name) or 0) + int(count or 0)
        into[key] = merged
    for key in ("failed", "cursors"):
        into[key] = {**(into.get(key) or {}), **(data.get(key) or {})}
    for key in ("completed", "full_entities", "warnings", "blocked_requests"):
        into[key] = list(into.get(key) or []) + list(data.get(key) or [])


def plan_modes(
    design: Mapping[str, Any],
    *,
    requested_entities: Optional[Sequence[str]],
    requested_mode: Optional[str],
    default_mode: str,
    last_full: Mapping[str, datetime],
    now: Optional[datetime] = None,
    recipe: Optional[Mapping[str, Any]] = None,
) -> Dict[str, str]:
    """``{entity: mode}`` for one refresh.

    An explicit mode wins. Otherwise: fixed content and entities without a
    cursor are full; an incremental entity whose ``full_every`` period has
    passed since its last clean full refresh is full this time.
    """
    now = now or datetime.now(timezone.utc)
    entities = {e["name"]: e for e in validate_design(design)["entities"]}
    names = list(entities)
    if requested_entities:
        unknown = [n for n in requested_entities if n not in entities]
        if unknown:
            raise SiteError("unknown entities: " + ", ".join(unknown))
        names = list(dict.fromkeys(requested_entities))
    if requested_mode is not None and requested_mode not in REFRESH_MODES:
        raise SiteError("mode must be incremental or full")
    out: Dict[str, str] = {}
    for name in names:
        spec = entities[name]
        refresh = spec.get("refresh") or {}
        if (
            spec["kind"] == "fixed"
            or not refresh.get("cursor")
            or recipe_entity(recipe, name).get("mode") == "full"
        ):
            mode = "full"
        elif requested_mode:
            mode = requested_mode
        else:
            mode = refresh.get("mode") or default_mode
            every = refresh.get("full_every")
            if mode == "incremental" and every:
                previous = last_full.get(name)
                if previous is None or now - previous >= parse_duration(every):
                    mode = "full"
        out[name] = mode
    return out


_LOCK_NS = 0x5173  # advisory-lock namespace for site refreshes
_background: Set["asyncio.Task[Any]"] = set()


def _lock_key(site: Site) -> int:
    return int(hashlib.sha256(site.id.encode()).hexdigest()[:7], 16)


async def _last_full_by_entity(conn: Any, site: Site) -> Dict[str, datetime]:
    rows = await conn.fetch(
        f"SELECT finished_at, detail FROM {_ident(site.schema_name)}._runs "
        "WHERE status IN ('ok', 'partial') AND detail IS NOT NULL ORDER BY finished_at DESC LIMIT 200"
    )
    out: Dict[str, datetime] = {}
    for row in rows:
        detail = _json_in(row["detail"]) or {}
        for name in detail.get("full_entities") or []:
            out.setdefault(name, row["finished_at"])
    return out


async def _cursors(conn: Any, design: Mapping[str, Any], modes: Mapping[str, str]) -> Dict[str, Any]:
    """Next cursor per incremental entity: the runner's last report, else the column max."""
    out: Dict[str, Any] = {}
    stored = await conn.fetchval("SELECT value FROM _meta WHERE key = 'cursors'")
    stored = _json_in(stored) if stored is not None else {}
    if not isinstance(stored, Mapping):
        stored = {}
    for spec in validate_design(design)["entities"]:
        cursor = (spec.get("refresh") or {}).get("cursor")
        if modes.get(spec["name"]) != "incremental" or not cursor:
            continue
        if stored.get(spec["name"]) is not None:
            out[spec["name"]] = stored[spec["name"]]
            continue
        value = await conn.fetchval(
            f"SELECT max({_ident(cursor)}) FROM {_ident(spec['name'])} WHERE _removed_at IS NULL"
        )
        out[spec["name"]] = jsonable(value)
    return out


async def start_refresh(
    site: Site,
    *,
    trigger: str,
    entities: Optional[Sequence[str]] = None,
    mode: Optional[str] = None,
    wait: bool = False,
    due: Optional[Callable[[Any], Any]] = None,
    db: Optional[SiteDatabase] = None,
) -> Optional[Dict[str, Any]]:
    """Begin a refresh; returns the run (``wait`` = after it finished).

    One refresh per site at a time (Postgres advisory lock, so two processes on
    the box can't double-run). ``due(conn)`` re-checks a schedule under the
    lock; when it says no, nothing runs and ``None`` comes back.
    """
    db = db or database()
    if site.status == "paused" and trigger == "schedule":
        return None
    current = await approved_design(site, db=db)
    if current is None:
        raise SiteError("approve a design before refreshing this site", 409)
    version, design, recipe = current
    if not recipe:
        raise SiteError("the approved design has no extraction recipe", 409)
    run_recipe = _recipe_runner()
    lock_conn = await db.privileged()
    handed_off = False
    try:
        got = await lock_conn.fetchval("SELECT pg_try_advisory_lock($1, $2)", _LOCK_NS, _lock_key(site))
        if not got:
            if trigger == "schedule":
                return None
            raise SiteError("a refresh of this site is already running", 409)
        try:
            if due is not None and not await due(lock_conn):
                return None
            modes = plan_modes(
                design,
                requested_entities=entities,
                requested_mode=mode,
                default_mode=site.default_refresh_mode,
                last_full=await _last_full_by_entity(lock_conn, site),
                recipe=recipe,
            )
            credential = await load_login(site)
            writer_conn = await db.restricted(site, write=True)
        except BaseException:
            await lock_conn.execute("SELECT pg_advisory_unlock($1, $2)", _LOCK_NS, _lock_key(site))
            raise
        writer = SiteWriter(site, design, writer_conn)
        run_mode = "incremental" if "incremental" in modes.values() else "full"
        try:
            cursors = await _cursors(writer_conn, design, modes)
            run = await writer.begin_run(run_mode, trigger)
        except BaseException:
            await writer_conn.close()
            await lock_conn.execute("SELECT pg_advisory_unlock($1, $2)", _LOCK_NS, _lock_key(site))
            raise
        run.entity_modes = dict(modes)
        task = asyncio.create_task(
            _drive(writer, run, run_recipe, recipe, credential, modes, cursors, lock_conn, site)
        )
        handed_off = True
        _background.add(task)
        task.add_done_callback(_background.discard)
        if wait:
            await task
        view = run.view()
        view["design_version"] = version
        view["entity_modes"] = modes
        return view
    finally:
        if not handed_off:
            await lock_conn.close()


async def _drive(
    writer: SiteWriter,
    run: SiteRun,
    run_recipe: Callable[..., Iterator[Any]],
    recipe: Mapping[str, Any],
    credential: Optional[Mapping[str, Any]],
    modes: Mapping[str, str],
    cursors: Mapping[str, Any],
    lock_conn: Any,
    site: Site,
) -> None:
    error: Optional[str] = None
    full: List[str] = []
    next_cursors: Dict[str, Any] = {}
    try:
        for group_mode in REFRESH_MODES:
            names = [n for n, m in modes.items() if m == group_mode]
            if not names:
                continue
            report = _new_report(run_recipe)
            kwargs: Dict[str, Any] = {
                "entities": names,
                "mode": group_mode,
                "cursors": {n: cursors.get(n) for n in names if n in cursors},
            }
            if report is not None:
                kwargs["report"] = report
            iterator = run_recipe(recipe, credential, **kwargs)
            try:
                await _consume(writer, run, iterator, set(names))
            except Exception as exc:
                # RecipeRunError: some entities failed, the rest completed and
                # the report says which. Anything else fails the whole run.
                if report is None or type(exc).__name__ != "RecipeRunError":
                    raise
            if report is None:
                if group_mode == "full":
                    full.extend(
                        n for n in names if recipe_entity(recipe, n).get("removal_safe", True) is not False
                    )
                continue
            data = _report_dict(report)
            _merge_report(run.report, data)
            run.pages += int(data.get("pages") or 0)
            for name, message in (data.get("failed") or {}).items():
                run.failed_entities.add(str(name))
                run.errors.append(f"{name}: {message}")
            full.extend(n for n in data.get("full_entities") or [] if n in names)
            next_cursors.update(
                {n: v for n, v in (data.get("cursors") or {}).items() if n in names}
            )
    except Exception as exc:  # noqa: BLE001 - recorded on the run
        password = str((credential or {}).get("password") or "")
        # BrowserNotInstalled already reads as a run error; others keep their class.
        error = str(exc) if type(exc).__name__ == "BrowserNotInstalled" else f"{type(exc).__name__}: {exc}"
        if password:
            error = error.replace(password, "***")
        logger.warning("site %s refresh failed: %s", site.slug, error)
    try:
        await writer.finish_run(run, full_entities=full, error=error, cursors=next_cursors)
    except Exception:  # noqa: BLE001
        logger.exception("site %s: could not close run %s", site.slug, run.id)
    finally:
        with contextlib.suppress(Exception):
            await writer.conn.close()
        with contextlib.suppress(Exception):
            await lock_conn.execute("SELECT pg_advisory_unlock($1, $2)", _LOCK_NS, _lock_key(site))
        with contextlib.suppress(Exception):
            await lock_conn.close()


_BATCH = 200
_DONE = object()


async def _consume(writer: SiteWriter, run: SiteRun, iterator: Iterator[Any], allowed: Set[str]) -> None:
    """Pull items from the (blocking) runner in a thread, write them in batches."""
    it = iter(iterator)
    raised: List[BaseException] = []

    def _take() -> List[Any]:
        batch: List[Any] = []
        try:
            for _ in range(_BATCH):
                item = next(it, _DONE)
                if item is _DONE:
                    break
                batch.append(item)
        except Exception as exc:  # noqa: BLE001 - re-raised once the batch is stored
            raised.append(exc)
        return batch

    while True:
        batch = await asyncio.to_thread(_take)
        if not batch and not raised:
            return
        variable: Dict[str, List[Tuple[Optional[str], Dict[str, Any]]]] = {}
        for item in batch:
            try:
                entity, kind, key, payload = _item_parts(item)
            except (TypeError, ValueError):
                run.failed += 1
                run.failed_entities.add("*")
                continue
            if entity == "_page":
                writer.add_pages(1)
                continue
            if entity not in allowed:
                continue
            spec = writer.entities.get(entity)
            if spec is None:
                run.failed += 1
                continue
            if spec["kind"] == "fixed":
                try:
                    await writer.record_fixed(entity, key, payload)
                except SiteError as exc:
                    run.failed += 1
                    run.failed_entities.add(entity)
                    run.errors.append(str(exc))
            else:
                variable.setdefault(entity, []).append((key, payload))
        for entity, records in variable.items():
            try:
                await writer.upsert(entity, records)
            except SiteError as exc:
                run.failed += len(records)
                run.failed_entities.add(entity)
                run.errors.append(str(exc))
        if raised:
            raise raised[0]


def schedule_due(cron: str, base: datetime, now: Optional[datetime] = None) -> bool:
    from croniter import croniter

    now = now or datetime.now(timezone.utc)
    nxt = croniter(cron, base).get_next(datetime)
    if nxt.tzinfo is None:
        nxt = nxt.replace(tzinfo=timezone.utc)
    return nxt <= now


def _due_check(site: Site) -> Callable[[Any], Any]:
    async def _due(conn: Any) -> bool:
        last = await conn.fetchval(
            f"SELECT max(started_at) FROM {_ident(site.schema_name)}._runs WHERE trigger = 'schedule'"
        )
        base = last or site.updated_at or datetime.now(timezone.utc)
        return schedule_due(site.schedule_cron or "", base)

    return _due


@contextlib.contextmanager
def _profile_home(profile: str):
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override
    from hermes_cli.profiles import get_profile_dir

    token = set_hermes_home_override(get_profile_dir(profile))
    try:
        yield
    finally:
        reset_hermes_home_override(token)


async def scheduler_tick(*, db: Optional[SiteDatabase] = None) -> List[str]:
    """Run every active, scheduled site that is due; returns their slugs."""
    db = db or database()
    if not db.configured():
        return []
    started: List[str] = []
    for site in await list_sites(profile=None, db=db):
        if site.status != "active" or not site.schedule_cron:
            continue
        try:
            with _profile_home(site.profile):
                result = await start_refresh(
                    site, trigger="schedule", wait=True, due=_due_check(site), db=db
                )
        except SiteError as exc:
            logger.info("site %s: scheduled refresh skipped: %s", site.slug, exc)
            continue
        except Exception:  # noqa: BLE001 - one bad site must not stop the rest
            logger.exception("site %s: scheduled refresh failed", site.slug)
            continue
        if result is not None:
            started.append(site.slug)
    return started


async def scheduler_loop(stop: asyncio.Event, *, interval: float = 60.0) -> None:
    """Tick :func:`scheduler_tick` until ``stop`` is set (web-server lifespan)."""
    while not stop.is_set():
        try:
            await scheduler_tick()
        except Exception:  # noqa: BLE001
            logger.exception("site scheduler tick failed")
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(stop.wait(), timeout=interval)


def scheduler_enabled(config: Mapping[str, Any]) -> bool:
    section = config.get("sites") if isinstance(config, Mapping) else None
    if isinstance(section, Mapping) and section.get("scheduler") is False:
        return False
    return database().configured()
