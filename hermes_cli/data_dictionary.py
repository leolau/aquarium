"""Data dictionary: what each Supabase table means, versioned and owner-approved.

Plan 2026-11-14-001, Phase 2. A *data source* is one site schema (kind
``site``) or Aquarium's own app data (kind ``app``, one per profile). Each
source has numbered dictionary versions: at most one open ``draft``, at most
one ``approved`` (the one answers use), older ones ``superseded`` and
discarded drafts ``rejected``.

Access (:func:`access_level`): ``manage`` for the profile's owner and admins,
the source's owner and a site's admins; ``propose`` / ``read`` by grant (a
site's read grantees also read its dictionary). Only ``manage`` approves.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Set

from hermes_cli import site_sources as ss
from hermes_cli.site_sources import SiteError, jsonable

logger = logging.getLogger(__name__)

LEVELS = ("read", "propose", "manage")
GRANTS = ("read", "propose")
ORIGINS = ("edit", "chat", "feedback", "study", "schema_check", "design", "restore")
APP_SOURCE_NAME = "Aquarium data"

_NAME_RE = re.compile(r"[a-z_][a-z0-9_]{0,62}")
_TEXT = {"meaning": 2000, "row": 500, "grain": 500}
_LISTS = {
    "joins": (("to", 63), ("on", 500), ("note", 500)),
    "metrics": (("name", 120), ("definition", 1000), ("sql", 4000)),
    "examples": (("question", 500), ("sql", 4000)),
}
_MAX_ITEMS = 50
_MAX_TABLES = 500
_MAX_COLUMNS = 300

DDL = """
CREATE TABLE IF NOT EXISTS public.data_sources (
    id uuid PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('site', 'app')),
    site_id uuid UNIQUE REFERENCES public.site_sources (id) ON DELETE CASCADE,
    profile text NOT NULL,
    name text NOT NULL,
    owner_user_id text NOT NULL DEFAULT '',
    schema_checked_at timestamptz,
    schema_drift jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((kind = 'site') = (site_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS data_sources_one_app
    ON public.data_sources (profile) WHERE kind = 'app';
CREATE TABLE IF NOT EXISTS public.data_source_grants (
    source_id uuid NOT NULL REFERENCES public.data_sources (id) ON DELETE CASCADE,
    user_id text NOT NULL,
    "grant" text NOT NULL CHECK ("grant" IN ('read', 'propose')),
    granted_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS data_source_grants_live
    ON public.data_source_grants (source_id, user_id) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS public.data_dictionary_versions (
    source_id uuid NOT NULL REFERENCES public.data_sources (id) ON DELETE CASCADE,
    version integer NOT NULL,
    status text NOT NULL CHECK (status IN ('draft', 'approved', 'superseded', 'rejected')),
    entries jsonb NOT NULL,
    changes jsonb NOT NULL DEFAULT '[]'::jsonb,
    based_on integer,
    proposed_by text NOT NULL,
    proposed_at timestamptz NOT NULL DEFAULT now(),
    approved_by text,
    approved_at timestamptz,
    PRIMARY KEY (source_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS data_dictionary_one_draft
    ON public.data_dictionary_versions (source_id) WHERE status = 'draft';
CREATE UNIQUE INDEX IF NOT EXISTS data_dictionary_one_approved
    ON public.data_dictionary_versions (source_id) WHERE status = 'approved';
REVOKE ALL ON public.data_sources, public.data_source_grants,
    public.data_dictionary_versions FROM PUBLIC;
"""

#: For installs that created the tables before the columns existed
#: (``CREATE TABLE IF NOT EXISTS`` leaves them alone).
_ALTER_DDL = """
ALTER TABLE public.data_sources ADD COLUMN IF NOT EXISTS schema_checked_at timestamptz;
ALTER TABLE public.data_sources ADD COLUMN IF NOT EXISTS schema_drift jsonb NOT NULL DEFAULT '[]'::jsonb;
"""

_TABLES = ("data_sources", "data_source_grants", "data_dictionary_versions")
_ready: set = set()


@dataclass
class Source:
    id: str
    kind: str
    profile: str
    name: str
    owner_user_id: str = ""
    site_id: Optional[str] = None
    schema_checked_at: Optional[Any] = None
    schema_drift: Optional[List[Dict[str, Any]]] = None

    def view(self, access: Optional[str] = None) -> Dict[str, Any]:
        out = {
            "id": self.id,
            "kind": self.kind,
            "name": self.name,
            "owner_user_id": self.owner_user_id,
            "site_id": self.site_id,
            "schema_checked_at": jsonable(self.schema_checked_at),
            "schema_drift": self.schema_drift or [],
        }
        if access is not None:
            out["access"] = access
        return out


def _source(row: Mapping[str, Any]) -> Source:
    return Source(
        id=str(row["id"]),
        kind=row["kind"],
        profile=row["profile"],
        name=row["name"],
        owner_user_id=row["owner_user_id"] or "",
        site_id=str(row["site_id"]) if row["site_id"] else None,
        schema_checked_at=row["schema_checked_at"],
        schema_drift=_json(row["schema_drift"]) or [],
    )


# -- access ------------------------------------------------------------------


def _rank(level: Optional[str]) -> int:
    return LEVELS.index(level) + 1 if level in LEVELS else 0


def access_level(
    source: Source, principal: Any, grant: Optional[str], site_access: Optional[str] = None
) -> Optional[str]:
    """``manage`` | ``propose`` | ``read`` | ``None`` (may not know it exists)."""
    if principal is None or not getattr(principal, "user_id", None):
        return None
    if ss._is_profile_admin(principal):
        return "manage"
    if source.owner_user_id and source.owner_user_id == principal.user_id:
        return "manage"
    levels = [grant if grant in GRANTS else None]
    if source.kind == "site" and site_access:
        levels.append("manage" if site_access == "admin" else "read")
    best = max(levels, key=_rank)
    return best if _rank(best) else None


def allows(access: Optional[str], need: str) -> bool:
    return _rank(access) >= _rank(need)


# -- entries -----------------------------------------------------------------


def _text(value: Any, field: str, limit: int) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise SiteError(f"{field} must be text")
    value = value.strip()
    if len(value) > limit:
        raise SiteError(f"{field} is longer than {limit} characters")
    return value


def _name(value: Any, field: str) -> str:
    name = str(value or "").strip()
    if not _NAME_RE.fullmatch(name):
        raise SiteError(f"{field} {name!r} must be lower-case letters, digits and _")
    return name


def validate_entry(table: str, raw: Any) -> Dict[str, Any]:
    """A normalised table entry, or :class:`SiteError`."""
    if not isinstance(raw, Mapping):
        raise SiteError(f"{table}: entry must be an object")
    out: Dict[str, Any] = {k: _text(raw.get(k), f"{table}.{k}", n) for k, n in _TEXT.items()}
    columns = raw.get("columns") or {}
    if not isinstance(columns, Mapping) or len(columns) > _MAX_COLUMNS:
        raise SiteError(f"{table}.columns must map up to {_MAX_COLUMNS} column names to text")
    out["columns"] = {
        _name(c, f"{table} column"): _text(d, f"{table}.columns.{c}", 500)
        for c, d in columns.items()
    }
    for key, fields in _LISTS.items():
        items = raw.get(key) or []
        if not isinstance(items, list) or len(items) > _MAX_ITEMS:
            raise SiteError(f"{table}.{key} must be a list of up to {_MAX_ITEMS}")
        clean = []
        for item in items:
            if not isinstance(item, Mapping):
                raise SiteError(f"{table}.{key}: each item must be an object")
            row = {f: _text(item.get(f), f"{table}.{key}.{f}", n) for f, n in fields}
            if not row[fields[0][0]]:
                raise SiteError(f"{table}.{key}: {fields[0][0]} is required")
            clean.append(row)
        out[key] = clean
    return out


def validate_glossary(raw: Any) -> List[Dict[str, str]]:
    if not isinstance(raw, list) or len(raw) > 200:
        raise SiteError("glossary must be a list of up to 200 terms")
    out = []
    for item in raw:
        if not isinstance(item, Mapping):
            raise SiteError("glossary: each term must be an object")
        term = _text(item.get("term"), "glossary.term", 120)
        if not term:
            raise SiteError("glossary: term is required")
        out.append({"term": term, "definition": _text(item.get("definition"), "glossary.definition", 1000)})
    return out


def _empty() -> Dict[str, Any]:
    return {"tables": {}, "glossary": []}


def changed_tables(before: Mapping[str, Any], after: Mapping[str, Any]) -> List[str]:
    a, b = before.get("tables") or {}, after.get("tables") or {}
    return sorted(t for t in set(a) | set(b) if a.get(t) != b.get(t))


def _json(value: Any) -> Any:
    return ss._json_in(value) if value is not None else None


# -- storage -----------------------------------------------------------------


async def _ensure(conn: Any, db: Any) -> None:
    key = db.dsn
    if key in _ready:
        return
    names = ", ".join(f"to_regclass('public.{t}')" for t in _TABLES)
    present = await conn.fetchval(f"SELECT bool_and(r IS NOT NULL) FROM (VALUES ({names})) v(r)")
    may = await conn.fetchval("SELECT has_schema_privilege('public', 'CREATE')")
    if may and not getattr(conn, "_hermes_skip_setup", False):
        # CREATE covers fresh installs; the ALTERs are the idempotent upgrade
        # path for tables created before the schema-check columns existed.
        await conn.execute(_ALTER_DDL if present else DDL + _ALTER_DDL)
    elif not present:
        raise SiteError(
            "the data dictionary tables are missing and this database login cannot "
            "create them; run `hermes db migrate`",
            503,
        )
    _ready.add(key)


class _Conn:
    def __init__(self, db: Any = None) -> None:
        self.db = db or ss.database()

    async def __aenter__(self) -> Any:
        self._cm = ss._registry(self.db)
        self.conn = await self._cm.__aenter__()
        try:
            await _ensure(self.conn, self.db)
        except BaseException as exc:
            await self._cm.__aexit__(type(exc), exc, exc.__traceback__)
            raise
        return self.conn

    async def __aexit__(self, *exc: Any) -> Any:
        return await self._cm.__aexit__(*exc)


async def migrate(conn: Any, *, app_role: Optional[str] = None) -> None:
    """``hermes db migrate`` step (schema owner): the dictionary tables and app-role grants."""
    from hermes_cli.access import APP_ROLE_NAME

    role = app_role or APP_ROLE_NAME
    if not re.fullmatch(r"[a-z_][a-z0-9_]{0,62}", role):
        raise ValueError(f"invalid role name {role!r}")
    await conn.execute(DDL + _ALTER_DDL)
    if await conn.fetchval("SELECT 1 FROM pg_roles WHERE rolname = $1", role):
        await conn.execute(
            f"GRANT USAGE ON SCHEMA public TO {role}; GRANT SELECT, INSERT, UPDATE, DELETE ON "
            + ", ".join(f"public.{t}" for t in _TABLES)
            + f" TO {role}"
        )


_SOURCE_COLUMNS = "id, kind, site_id, profile, name, owner_user_id, schema_checked_at, schema_drift"


def _design_entries(design: Mapping[str, Any]) -> Dict[str, Any]:
    tables = {}
    for entity in design.get("entities") or []:
        tables[entity["name"]] = validate_entry(entity["name"], {
            "meaning": str(entity.get("reason") or "")[:2000],
            "columns": {c["name"]: str(c.get("description") or "")[:500] for c in entity["columns"]},
        })
    return {"tables": tables, "glossary": []}


async def sync_sources(profile: str, *, db: Any = None) -> List[Source]:
    """This profile's sources: the app source plus one per site, created as needed.

    A new site source starts from the site's approved design (its reasons) as
    version 1, approved by whoever approved the design.
    """
    sites = await ss.list_sites(profile=profile, db=db)
    seeds: List[Source] = []
    async with _Conn(db) as conn:
        async with conn.transaction():
            await conn.execute(
                "INSERT INTO public.data_sources (id, kind, profile, name) VALUES ($1, 'app', $2, $3) "
                "ON CONFLICT (profile) WHERE kind = 'app' DO NOTHING",
                uuid.uuid4(), profile, APP_SOURCE_NAME,
            )
            for site in sites:
                row = await conn.fetchrow(
                    "INSERT INTO public.data_sources (id, kind, site_id, profile, name, owner_user_id) "
                    "VALUES ($1, 'site', $2::uuid, $3, $4, $5) ON CONFLICT (site_id) DO UPDATE "
                    "SET name = EXCLUDED.name, owner_user_id = EXCLUDED.owner_user_id, "
                    "profile = EXCLUDED.profile, updated_at = now() "
                    "WHERE (data_sources.name, data_sources.owner_user_id, data_sources.profile) "
                    "IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.owner_user_id, EXCLUDED.profile) "
                    f"RETURNING {_SOURCE_COLUMNS}, (xmax = 0) AS created",
                    uuid.uuid4(), site.id, profile, site.name, site.owner_user_id,
                )
                if row is not None and row["created"]:
                    seeds.append(_source(row))
        rows = await conn.fetch(
            f"SELECT {_SOURCE_COLUMNS} FROM public.data_sources WHERE profile = $1 "
            "ORDER BY kind = 'site', name",
            profile,
        )
    by_site = {s.id: s for s in sites}
    for source in seeds:
        site = by_site.get(source.site_id or "")
        try:
            designs = await ss.list_designs(site, db=db) if site is not None else []
        except SiteError:
            designs = []
        approved = next((d for d in designs if d.get("status") == "approved"), None)
        if approved:
            async with _Conn(db) as conn:
                await conn.execute(
                    "INSERT INTO public.data_dictionary_versions (source_id, version, status, entries, "
                    "changes, proposed_by, approved_by, approved_at) VALUES ($1::uuid, 1, 'approved', "
                    "$2::jsonb, $3::jsonb, $4, $4, now()) ON CONFLICT DO NOTHING",
                    source.id,
                    json.dumps(_design_entries(approved["design"])),
                    json.dumps([{"table": "*", "origin": "design", "by": approved.get("approved_by") or "",
                                 "note": f"From site design v{approved['version']}"}]),
                    approved.get("approved_by") or source.owner_user_id or "system",
                )
    return [_source(r) for r in rows]


async def get_source(source_id: str, *, db: Any = None) -> Optional[Source]:
    try:
        uuid.UUID(str(source_id))
    except ValueError:
        return None
    async with _Conn(db) as conn:
        row = await conn.fetchrow(
            f"SELECT {_SOURCE_COLUMNS} FROM public.data_sources WHERE id = $1::uuid", str(source_id)
        )
    return _source(row) if row else None


async def resolve_access(source: Source, principal: Any, *, db: Any = None) -> Optional[str]:
    if principal is None or not getattr(principal, "user_id", None):
        return None
    if ss._is_profile_admin(principal) or source.owner_user_id == principal.user_id:
        return "manage"
    grant = await grant_for(source.id, principal.user_id, db=db)
    site_access = None
    if source.kind == "site" and source.site_id:
        site = await ss.get_site(source.site_id, db=db)
        if site is not None:
            site_access = ss.access_level(
                site, principal, await ss.grant_for(site.id, principal.user_id, db=db)
            )
    return access_level(source, principal, grant, site_access)


async def list_sources(principal: Any, profile: str, *, db: Any = None) -> List[Dict[str, Any]]:
    """Sources ``principal`` may see, each with its dictionary status."""
    if principal is None or not getattr(principal, "user_id", None):
        return []
    sources = await sync_sources(profile, db=db)
    site_grants = await ss.grants_of(principal.user_id, db=db)
    sites = {s.id: s for s in await ss.list_sites(profile=profile, db=db)}
    async with _Conn(db) as conn:
        grants = {
            str(r["source_id"]): r["grant"]
            for r in await conn.fetch(
                'SELECT source_id, "grant" FROM public.data_source_grants '
                "WHERE user_id = $1 AND revoked_at IS NULL",
                principal.user_id,
            )
        }
        versions = await conn.fetch(
            "SELECT v.source_id, v.version, v.status, v.entries, v.changes, v.proposed_at, v.approved_at "
            "FROM public.data_dictionary_versions v JOIN public.data_sources s ON s.id = v.source_id "
            "WHERE s.profile = $1 AND v.status IN ('draft', 'approved')",
            profile,
        )
    state: Dict[str, Dict[str, Any]] = {}
    for row in versions:
        state.setdefault(str(row["source_id"]), {})[row["status"]] = row
    out = []
    for source in sources:
        site = sites.get(source.site_id or "")
        site_access = (
            ss.access_level(site, principal, site_grants.get(site.id)) if site is not None else None
        )
        access = access_level(source, principal, grants.get(source.id), site_access)
        if access is None:
            continue
        item = source.view(access)
        current = state.get(source.id, {})
        approved, draft = current.get("approved"), current.get("draft")
        item["approved_version"] = approved["version"] if approved else None
        item["approved_at"] = jsonable(approved["approved_at"]) if approved else None
        item["tables_described"] = len((_json(approved["entries"]) or {}).get("tables") or {}) if approved else 0
        if draft is not None and allows(access, "propose"):
            item["draft_version"] = draft["version"]
            item["draft_changes"] = len(changed_tables(
                _json(approved["entries"]) if approved else _empty(), _json(draft["entries"])
            ))
            item["draft_proposed_at"] = jsonable(draft["proposed_at"])
            item["draft_origins"] = sorted({c.get("origin") for c in _json(draft["changes"]) or [] if c.get("origin")})
        else:
            item["draft_version"] = None
            item["draft_changes"] = 0
            item["draft_origins"] = []
        item["status"] = (
            "draft" if item["draft_version"] else "approved" if approved else "not_described"
        )
        out.append(item)
    return out


def _version_view(row: Mapping[str, Any], *, entries: bool = True) -> Dict[str, Any]:
    out = {
        "version": row["version"],
        "status": row["status"],
        "based_on": row["based_on"],
        "changes": _json(row["changes"]) or [],
        "proposed_by": row["proposed_by"],
        "proposed_at": jsonable(row["proposed_at"]),
        "approved_by": row["approved_by"],
        "approved_at": jsonable(row["approved_at"]),
    }
    if entries:
        out["entries"] = _json(row["entries"])
    return out


_VERSION_COLUMNS = (
    "version, status, entries, changes, based_on, proposed_by, proposed_at, approved_by, approved_at"
)


async def dictionary(source: Source, *, draft: bool = False, db: Any = None) -> Dict[str, Any]:
    """The approved version, and the open draft with its changed tables when ``draft``."""
    async with _Conn(db) as conn:
        rows = await conn.fetch(
            f"SELECT {_VERSION_COLUMNS} FROM public.data_dictionary_versions "
            "WHERE source_id = $1::uuid AND status IN ('draft', 'approved')",
            source.id,
        )
    by = {r["status"]: r for r in rows}
    approved = _version_view(by["approved"]) if "approved" in by else None
    out: Dict[str, Any] = {"approved": approved, "schema_drift": source.schema_drift or []}
    # Changed/removed tables are flagged so readers (UI, the agent's site_db
    # tool) can see their text no longer describes the live schema.
    for item in source.schema_drift or ():
        if item.get("change") in ("columns", "removed") and approved is not None:
            table = (approved["entries"].get("tables") or {}).get(item.get("table"))
            if table is not None:
                table["stale"] = True
    if draft:
        open_draft = _version_view(by["draft"]) if "draft" in by else None
        if open_draft is not None:
            open_draft["changed_tables"] = changed_tables(
                approved["entries"] if approved else _empty(), open_draft["entries"]
            )
        out["draft"] = open_draft
    return out


async def list_versions(source: Source, *, db: Any = None) -> List[Dict[str, Any]]:
    async with _Conn(db) as conn:
        rows = await conn.fetch(
            f"SELECT {_VERSION_COLUMNS} FROM public.data_dictionary_versions "
            "WHERE source_id = $1::uuid ORDER BY version DESC",
            source.id,
        )
    return [_version_view(r, entries=False) for r in rows]


async def get_version(source: Source, version: int, *, db: Any = None) -> Dict[str, Any]:
    async with _Conn(db) as conn:
        row = await conn.fetchrow(
            f"SELECT {_VERSION_COLUMNS} FROM public.data_dictionary_versions "
            "WHERE source_id = $1::uuid AND version = $2",
            source.id, int(version),
        )
    if row is None:
        raise SiteError(f"no dictionary version {version}", 404)
    return _version_view(row)


async def _lock(conn: Any, source: Source) -> Optional[Mapping[str, Any]]:
    """Lock the source row (serialises writers); its approved version row, if any."""
    await conn.fetchval("SELECT 1 FROM public.data_sources WHERE id = $1::uuid FOR UPDATE", source.id)
    return await conn.fetchrow(
        f"SELECT {_VERSION_COLUMNS} FROM public.data_dictionary_versions "
        "WHERE source_id = $1::uuid AND status = 'approved'",
        source.id,
    )


async def propose(
    source: Source,
    *,
    tables: Optional[Mapping[str, Any]] = None,
    remove: Sequence[str] = (),
    glossary: Any = None,
    origin: str = "edit",
    note: str = "",
    by: str,
    db: Any = None,
) -> Dict[str, Any]:
    """Put whole-table entries (and removals, glossary) into the open draft."""
    if origin not in ORIGINS:
        raise SiteError("origin must be one of: " + ", ".join(ORIGINS))
    if tables is not None and not isinstance(tables, Mapping):
        raise SiteError("tables must map table names to entries")
    clean = {_name(t, "table"): validate_entry(t, e) for t, e in (tables or {}).items()}
    dropped = [_name(t, "table") for t in remove or ()]
    terms = validate_glossary(glossary) if glossary is not None else None
    note = _text(note, "note", 500)
    if not clean and not dropped and terms is None:
        raise SiteError("nothing to propose: give tables, remove or glossary")
    async with _Conn(db) as conn:
        async with conn.transaction():
            approved = await _lock(conn, source)
            draft = await conn.fetchrow(
                "SELECT version, entries, changes FROM public.data_dictionary_versions "
                "WHERE source_id = $1::uuid AND status = 'draft'",
                source.id,
            )
            if draft is not None:
                version, entries = draft["version"], _json(draft["entries"])
                changes = _json(draft["changes"]) or []
            else:
                version = await conn.fetchval(
                    "SELECT coalesce(max(version), 0) + 1 FROM public.data_dictionary_versions "
                    "WHERE source_id = $1::uuid",
                    source.id,
                )
                entries = _json(approved["entries"]) if approved else _empty()
                changes = []
            entries.setdefault("tables", {})
            entries["tables"].update(clean)
            for table in dropped:
                entries["tables"].pop(table, None)
            if len(entries["tables"]) > _MAX_TABLES:
                raise SiteError(f"a dictionary holds at most {_MAX_TABLES} tables")
            if terms is not None:
                entries["glossary"] = terms
            touched = sorted(clean) + [f"-{t}" for t in dropped] + (["glossary"] if terms is not None else [])
            changes.extend({"table": t, "origin": origin, "by": by, "note": note} for t in touched)
            if draft is None:
                await conn.execute(
                    "INSERT INTO public.data_dictionary_versions (source_id, version, status, entries, "
                    "changes, based_on, proposed_by) VALUES ($1::uuid, $2, 'draft', $3::jsonb, $4::jsonb, $5, $6)",
                    source.id, version, json.dumps(entries), json.dumps(changes),
                    approved["version"] if approved else None, by,
                )
            else:
                await conn.execute(
                    "UPDATE public.data_dictionary_versions SET entries = $3::jsonb, changes = $4::jsonb "
                    "WHERE source_id = $1::uuid AND version = $2",
                    source.id, version, json.dumps(entries), json.dumps(changes),
                )
    before = _json(approved["entries"]) if approved else _empty()
    return {"version": version, "status": "draft", "changed_tables": changed_tables(before, entries)}


async def add_example(
    source: Source, *, table: str, question: str, sql: str, by: str, db: Any = None
) -> Dict[str, Any]:
    """Put a confirmed question and its SQL into ``table``'s examples in the draft."""
    table = _name(table, "table")
    found = await dictionary(source, draft=True, db=db)
    base = (found.get("draft") or found.get("approved") or {}).get("entries") or _empty()
    entry = dict((base.get("tables") or {}).get(table) or {})
    example = {"question": _text(question, "question", 500), "sql": _text(sql, "sql", 4000)}
    if not example["question"] or not example["sql"]:
        raise SiteError("give the question and its SQL")
    examples = [e for e in entry.get("examples") or [] if e.get("question") != example["question"]]
    entry["examples"] = (examples + [example])[-_MAX_ITEMS:]
    return await propose(
        source, tables={table: entry}, origin="feedback", note="Confirmed answer", by=by, db=db
    )


async def approve(
    source: Source, version: int, *, reject: Iterable[str] = (), by: str, db: Any = None
) -> Dict[str, Any]:
    """Approve draft ``version``; tables in ``reject`` keep their approved text.

    ``version`` must be the open draft, so approving a draft that changed or
    was replaced since the reviewer loaded it fails instead of passing unseen text.
    """
    rejected = {str(t) for t in reject or ()}
    async with _Conn(db) as conn:
        async with conn.transaction():
            approved = await _lock(conn, source)
            draft = await conn.fetchrow(
                "SELECT version, entries FROM public.data_dictionary_versions "
                "WHERE source_id = $1::uuid AND status = 'draft'",
                source.id,
            )
            if draft is None or draft["version"] != int(version):
                raise SiteError(f"version {version} is not the open draft; reload and review again", 409)
            before = _json(approved["entries"]) if approved else _empty()
            entries = _json(draft["entries"])
            for table in rejected:
                if table == "glossary":
                    entries["glossary"] = before.get("glossary") or []
                elif table in (before.get("tables") or {}):
                    entries["tables"][table] = before["tables"][table]
                else:
                    entries["tables"].pop(table, None)
            if not changed_tables(before, entries) and entries.get("glossary") == before.get("glossary"):
                await conn.execute(
                    "UPDATE public.data_dictionary_versions SET status = 'rejected', approved_by = $3, "
                    "approved_at = now() WHERE source_id = $1::uuid AND version = $2",
                    source.id, int(version), by,
                )
                return {"version": int(version), "status": "rejected"}
            await conn.execute(
                "UPDATE public.data_dictionary_versions SET status = 'superseded' "
                "WHERE source_id = $1::uuid AND status = 'approved'",
                source.id,
            )
            await conn.execute(
                "UPDATE public.data_dictionary_versions SET status = 'approved', entries = $3::jsonb, "
                "approved_by = $4, approved_at = now() WHERE source_id = $1::uuid AND version = $2",
                source.id, int(version), json.dumps(entries), by,
            )
            await conn.execute(
                "UPDATE public.data_sources SET updated_at = now() WHERE id = $1::uuid", source.id
            )
    result = {"version": int(version), "status": "approved", "changed_tables": changed_tables(before, entries)}
    await _recheck_quiet(source, db=db)
    return result


async def discard(source: Source, *, by: str, db: Any = None) -> bool:
    async with _Conn(db) as conn:
        result = await conn.execute(
            "UPDATE public.data_dictionary_versions SET status = 'rejected', approved_by = $2, "
            "approved_at = now() WHERE source_id = $1::uuid AND status = 'draft'",
            source.id, by,
        )
    return not result.endswith(" 0")


async def restore(source: Source, version: int, *, by: str, db: Any = None) -> Dict[str, Any]:
    """Make an earlier version's text the approved one again, as a new version."""
    async with _Conn(db) as conn:
        async with conn.transaction():
            approved = await _lock(conn, source)
            if await conn.fetchval(
                "SELECT 1 FROM public.data_dictionary_versions WHERE source_id = $1::uuid AND status = 'draft'",
                source.id,
            ):
                raise SiteError("approve or discard the open draft before restoring", 409)
            old = await conn.fetchrow(
                "SELECT entries, status FROM public.data_dictionary_versions "
                "WHERE source_id = $1::uuid AND version = $2",
                source.id, int(version),
            )
            if old is None or old["status"] not in ("approved", "superseded"):
                raise SiteError(f"version {version} was never approved", 404)
            if old["status"] == "approved":
                return {"version": int(version), "status": "approved", "unchanged": True}
            new = await conn.fetchval(
                "SELECT max(version) + 1 FROM public.data_dictionary_versions WHERE source_id = $1::uuid",
                source.id,
            )
            await conn.execute(
                "UPDATE public.data_dictionary_versions SET status = 'superseded' "
                "WHERE source_id = $1::uuid AND status = 'approved'",
                source.id,
            )
            await conn.execute(
                "INSERT INTO public.data_dictionary_versions (source_id, version, status, entries, changes, "
                "based_on, proposed_by, approved_by, approved_at) VALUES ($1::uuid, $2, 'approved', $3, "
                "$4::jsonb, $5, $6, $6, now())",
                source.id, new, old["entries"] if isinstance(old["entries"], str) else json.dumps(old["entries"]),
                json.dumps([{"table": "*", "origin": "restore", "by": by, "note": f"Restored v{version}"}]),
                approved["version"] if approved else None, by,
            )
    result = {"version": new, "status": "approved", "restored_from": int(version)}
    await _recheck_quiet(source, db=db)
    return result


# -- schema-change check ----------------------------------------------------

#: How long a recorded check stays fresh before the scheduled job re-checks.
SCHEMA_CHECK_EVERY = timedelta(hours=24)


def schema_diff(
    truth: Mapping[str, Set[str]], tables: Mapping[str, Any]
) -> List[Dict[str, Any]]:
    """Diff the real schema (``{table: {columns}}``) against approved entries.

    Returns one item per differing table: ``added`` (in the schema but not
    documented), ``removed`` (documented but gone), ``columns`` (set differs).
    """
    out: List[Dict[str, Any]] = []
    for name in sorted(set(truth) | set(tables)):
        want = truth.get(name)
        have = tables.get(name)
        if want is None:
            out.append({"table": name, "change": "removed"})
        elif have is None:
            out.append({"table": name, "change": "added", "detail": {"columns": sorted(want)}})
        else:
            cols = set(have.get("columns") or {})
            added, removed = sorted(want - cols), sorted(cols - want)
            if added or removed:
                out.append({"table": name, "change": "columns",
                            "detail": {"added": added, "removed": removed}})
    return out


async def _schema_truth(source: Source, *, db: Any = None) -> Dict[str, Set[str]]:
    """The schema the approved dictionary should describe: ``{table: {columns}}``.

    Site sources follow their site's approved design; the app source follows
    the areas the code currently exposes.
    """
    if source.kind == "app":
        from hermes_cli import app_data

        return {name: set(cols) for name, cols in app_data.schema().items()}
    if not source.site_id:
        return {}
    site = await ss.get_site(source.site_id, db=db)
    if site is None:
        return {}
    current = await ss.approved_design(site, db=db)
    if current is None:
        return {}
    _version, design, _recipe = current
    return {
        e["name"]: {c["name"] for c in e["columns"]}
        for e in ss.validate_design(design)["entities"]
    }


async def check_source(source: Source, *, db: Any = None) -> List[Dict[str, Any]]:
    """Compare the source's schema with its approved dictionary; record the drift."""
    truth = await _schema_truth(source, db=db)
    async with _Conn(db) as conn:
        approved = await conn.fetchrow(
            "SELECT entries FROM public.data_dictionary_versions "
            "WHERE source_id = $1::uuid AND status = 'approved'",
            source.id,
        )
        tables = (_json(approved["entries"]) or {}).get("tables") or {} if approved else {}
        drift = schema_diff(truth, tables) if approved else []
        await conn.execute(
            "UPDATE public.data_sources SET schema_checked_at = now(), schema_drift = $2::jsonb "
            "WHERE id = $1::uuid",
            source.id, json.dumps(drift),
        )
    return drift


async def recheck_site(site_id: Any, *, db: Any = None) -> None:
    """Re-check the data source bound to ``site_id`` (called after a design change)."""
    async with _Conn(db) as conn:
        row = await conn.fetchrow(
            f"SELECT {_SOURCE_COLUMNS} FROM public.data_sources WHERE site_id = $1::uuid",
            str(site_id),
        )
    if row is not None:
        await check_source(_source(row), db=db)


async def _recheck_quiet(source: Source, *, db: Any = None) -> None:
    """Best-effort re-check after a write — never fails the write itself."""
    try:
        await check_source(source, db=db)
    except Exception:  # noqa: BLE001
        logger.warning("schema re-check failed for source %s", source.id, exc_info=True)


async def schema_check_tick(*, db: Any = None) -> int:
    """Re-check every approved source whose last check is missing or stale."""
    cutoff = datetime.now(timezone.utc) - SCHEMA_CHECK_EVERY
    async with _Conn(db) as conn:
        rows = await conn.fetch(
            f"SELECT {_SOURCE_COLUMNS} FROM public.data_sources s "
            "WHERE EXISTS (SELECT 1 FROM public.data_dictionary_versions v "
            "WHERE v.source_id = s.id AND v.status = 'approved') "
            "AND (s.schema_checked_at IS NULL OR s.schema_checked_at < $1)",
            cutoff,
        )
    checked = 0
    for row in rows:
        try:
            await check_source(_source(row), db=db)
            checked += 1
        except Exception:  # noqa: BLE001 - one bad source never stops the sweep
            logger.warning("schema check failed for source %s", row["id"], exc_info=True)
    return checked


async def schema_check_loop(stop: asyncio.Event, *, interval: float = 3600.0, db: Any = None) -> None:
    """Hourly sweep; each source is re-checked at most once per SCHEMA_CHECK_EVERY."""
    while not stop.is_set():
        try:
            await schema_check_tick(db=db)
        except Exception:  # noqa: BLE001 - the sweep keeps running
            logger.exception("data dictionary schema check failed")
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(stop.wait(), timeout=interval)


# -- grants ------------------------------------------------------------------


async def grant_for(source_id: str, user_id: str, *, db: Any = None) -> Optional[str]:
    async with _Conn(db) as conn:
        return await conn.fetchval(
            'SELECT "grant" FROM public.data_source_grants '
            "WHERE source_id = $1::uuid AND user_id = $2 AND revoked_at IS NULL",
            source_id, user_id,
        )


async def list_grants(source_id: str, *, db: Any = None) -> List[Dict[str, Any]]:
    async with _Conn(db) as conn:
        rows = await conn.fetch(
            'SELECT user_id, "grant", granted_by, created_at FROM public.data_source_grants '
            "WHERE source_id = $1::uuid AND revoked_at IS NULL ORDER BY created_at",
            source_id,
        )
    return [jsonable(dict(r)) for r in rows]


async def put_grant(source_id: str, user_id: str, grant: str, *, by: str, db: Any = None) -> Dict[str, Any]:
    if grant not in GRANTS:
        raise SiteError("grant must be read or propose")
    user_id = str(user_id or "").strip()
    if not user_id:
        raise SiteError("user_id is required")
    async with _Conn(db) as conn:
        async with conn.transaction():
            await conn.execute(
                "UPDATE public.data_source_grants SET revoked_at = now() "
                "WHERE source_id = $1::uuid AND user_id = $2 AND revoked_at IS NULL",
                source_id, user_id,
            )
            await conn.execute(
                'INSERT INTO public.data_source_grants (source_id, user_id, "grant", granted_by) '
                "VALUES ($1::uuid, $2, $3, $4)",
                source_id, user_id, grant, by,
            )
    return {"user_id": user_id, "grant": grant, "granted_by": by}


async def revoke_grant(source_id: str, user_id: str, *, db: Any = None) -> bool:
    async with _Conn(db) as conn:
        result = await conn.execute(
            "UPDATE public.data_source_grants SET revoked_at = now() "
            "WHERE source_id = $1::uuid AND user_id = $2 AND revoked_at IS NULL",
            source_id, str(user_id or ""),
        )
    return not result.endswith(" 0")
