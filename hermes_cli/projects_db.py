"""Root-anchored first-class Project store.

A **Project** is the durable record of a piece of work that can be reviewed,
repeated and learnt from (see
``docs/design/master-plan/feature-groups/FG-32-projects-durable-record.md``).
It anchors:

- **Desktop session grouping** — a session belongs to a project when its
  ``cwd`` lives under one of the project's folders (longest-prefix match).
- **Kanban task worktrees** — a task linked to a project creates its worktree
  under the project's primary repo with a deterministic branch name, instead
  of the random ``wt/<task-id>`` fallback.

Scope: **shared root**, stored at ``kanban_home() / "projects.db"`` — the
same resolver the kanban board uses, so the two can never disagree about
which root they are on. A project's work IS kanban cards and its schedule IS
a ``hermes cron`` job, so the record must live where both live: above any one
profile. ``HERMES_PROJECTS_DB`` overrides the resolution for tests and odd
deployments (and is the reversibility lever for the root migration).

Legacy per-profile stores (``$HERMES_HOME/projects.db``) are imported into
the root DB on first open (:func:`import_profile_stores`); the per-profile
files are left in place, untouched and unread afterwards.

The schema is intentionally additive: column additions go through
:func:`_add_column_if_missing` so opening an old DB is always safe.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import re
import secrets
import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, List, Optional
from urllib.parse import urlparse

from hermes_cli.sqlite_util import add_column_if_missing as _add_column_if_missing, write_txn
from hermes_constants import get_hermes_home

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------


def projects_db_path() -> Path:
    """The shared-root projects DB path (``kanban_home() / "projects.db"``).

    Resolution order:

    1. ``HERMES_PROJECTS_DB`` env var when set and non-empty (explicit
       override for tests, unusual deployments, and the reversibility path
       for the root migration).
    2. ``kanban_db.kanban_home() / "projects.db"`` — the same resolver the
       board uses, so projects and cards always share a root.

    The kanban import is lazy: ``kanban_db`` imports this module inside a
    function, and a module-level import here would close the loop.
    """
    override = os.environ.get("HERMES_PROJECTS_DB", "").strip()
    if override:
        return Path(override).expanduser()
    from hermes_cli.kanban_db import kanban_home

    return kanban_home() / "projects.db"


def legacy_profile_projects_db_path() -> Path:
    """The old per-profile location (``$HERMES_HOME/projects.db``).

    Kept for the one-shot root import (:func:`import_profile_stores`) and
    for callers that need to *name* the legacy file (backups, diagnostics).
    Runtime reads and writes never touch it.
    """
    return get_hermes_home() / "projects.db"


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS projects (
    id            TEXT PRIMARY KEY,
    slug          TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    description   TEXT,
    icon          TEXT,
    color         TEXT,
    board_slug    TEXT,
    primary_path  TEXT,
    created_at    INTEGER NOT NULL,
    archived      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS project_folders (
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    path        TEXT NOT NULL,
    label       TEXT,
    is_primary  INTEGER NOT NULL DEFAULT 0,
    added_at    INTEGER NOT NULL,
    PRIMARY KEY (project_id, path)
);

CREATE INDEX IF NOT EXISTS idx_project_folders_path
    ON project_folders(path);

CREATE TABLE IF NOT EXISTS project_meta (
    key    TEXT PRIMARY KEY,
    value  TEXT
);

-- User-managed project categories (Sales, Marketing, …): the kanban columns
-- of the /projects board. ``projects.category_id`` points here; NULL is
-- "Uncategorized". Names are unique case-insensitively.
CREATE TABLE IF NOT EXISTS project_categories (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    color       TEXT,
    position    INTEGER NOT NULL DEFAULT 0,
    created_by  TEXT,
    created_at  INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_categories_name
    ON project_categories(lower(name));

-- Git repos found by scanning the filesystem (desktop "repo-first" discovery).
-- Cached here so the overview is instant after the first scan instead of
-- re-walking the disk every time the Projects view opens.
CREATE TABLE IF NOT EXISTS discovered_repos (
    root          TEXT PRIMARY KEY,
    label         TEXT,
    last_seen     INTEGER NOT NULL
);

-- Projects page (2026-08-12 plan): cross-profile membership and link table.
-- A project_links row is a pointer, never a copy — the authority stays in
-- the profile that owns it, and `profile` is what makes the pointer resolvable.
CREATE TABLE IF NOT EXISTS project_profiles (
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    profile     TEXT NOT NULL,
    role        TEXT NOT NULL DEFAULT 'member',
    added_by    TEXT,
    added_at    INTEGER NOT NULL,
    PRIMARY KEY (project_id, profile)
);

CREATE TABLE IF NOT EXISTS project_links (
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,
    profile     TEXT NOT NULL,
    ref         TEXT NOT NULL,
    label       TEXT,
    added_by    TEXT,
    added_at    INTEGER NOT NULL,
    PRIMARY KEY (project_id, kind, profile, ref)
);

CREATE INDEX IF NOT EXISTS idx_project_links_kind
    ON project_links(project_id, kind, added_at DESC);

-- ── Projects feature (design §2.2) ───────────────────────────────────────────────

-- People. A member is a *person* (box-wide user id); a participant profile is
-- an *instrument* the work runs on (project_profiles above). Both lists are
-- needed and they are not the same list.
CREATE TABLE IF NOT EXISTS project_members (
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL,
    role        TEXT NOT NULL DEFAULT 'member',   -- lead | member | viewer
    added_by    TEXT,
    added_at    INTEGER NOT NULL,
    PRIMARY KEY (project_id, user_id)
);

-- [10] contacts: people involved who are not users of this box. No principal,
-- no permissions, no global address book. `address` may be an outbound
-- destination and is therefore PII: returned to members only, never to a
-- viewer, and never compiled into a run prompt unless the step needs it.
CREATE TABLE IF NOT EXISTS project_contacts (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    role        TEXT,                       -- 'client', 'reviewer', 'the list' …
    org         TEXT,
    platform    TEXT,                       -- email | telegram | slack | phone | …
    address     TEXT,                       -- PII; see the note above
    user_id     TEXT,                       -- set when the contact also has a principal
    notes       TEXT,
    created_by  TEXT,
    created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_contacts_project
    ON project_contacts(project_id);

-- [3] outputs: the deliverables, declared before the work. Mandatory: a
-- project has at least one row. This table is what gives progress a
-- denominator that means something.
CREATE TABLE IF NOT EXISTS project_outputs (
    id            TEXT PRIMARY KEY,
    project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    seq           INTEGER NOT NULL,          -- display order
    title         TEXT NOT NULL,             -- "The Monday digest email"
    spec          TEXT,                      -- what "good" looks like; free text
    kind          TEXT NOT NULL DEFAULT 'artifact',
                                             -- artifact | file | message | decision | report | code
    required      INTEGER NOT NULL DEFAULT 1,
    recurring     INTEGER NOT NULL DEFAULT 0, -- delivered once per run (repeatable projects)
    status        TEXT NOT NULL DEFAULT 'pending',
                                             -- pending | in_progress | delivered | accepted | dropped
    delivered_at  INTEGER,
    accepted_at   INTEGER,                   -- a human accepted it; only a human may
    accepted_by   TEXT,
    created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_outputs_project
    ON project_outputs(project_id, seq);

-- One row per *delivery* of an output: which run produced it and what the
-- artefact is. `recurring` outputs accumulate one row per run.
CREATE TABLE IF NOT EXISTS project_output_deliveries (
    id           TEXT PRIMARY KEY,
    output_id    TEXT NOT NULL REFERENCES project_outputs(id) ON DELETE CASCADE,
    run_id       TEXT,                       -- project_runs.id, when a run produced it
    task_id      TEXT,                       -- the card that produced it, when any
    link_kind    TEXT,                       -- file | url | attachment | session | memory
    link_ref     TEXT,                       -- the pointer, resolved under the caller's principal
    profile      TEXT,                       -- which profile owns the referent
    label        TEXT,                       -- cached display label (link rot)
    note         TEXT,
    delivered_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_output_deliveries_output
    ON project_output_deliveries(output_id, delivered_at DESC);

-- The method: a versioned playbook. One row per revision; `steps` is a JSON
-- array of card templates (design §7). A new revision is created inactive
-- and activated by a human.
CREATE TABLE IF NOT EXISTS project_playbook (
    project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    rev          INTEGER NOT NULL,
    body         TEXT NOT NULL DEFAULT '',   -- prose: what this project does
    steps        TEXT NOT NULL DEFAULT '[]', -- JSON: ordered card templates
    active       INTEGER NOT NULL DEFAULT 0,
    created_by   TEXT,
    created_at   INTEGER NOT NULL,
    activated_at INTEGER,
    note         TEXT,                        -- why this revision exists (often a retro id)
    PRIMARY KEY (project_id, rev)
);

-- The method: guidance the user gives over time. A directive is a standing
-- instruction; feedback is a judgement about a run or a card. Both are
-- durable and compiled into future run prompts; neither is ever injected
-- into a live conversation.
CREATE TABLE IF NOT EXISTS project_directives (
    id            TEXT PRIMARY KEY,
    project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL,              -- directive | feedback
    body          TEXT NOT NULL,
    scope         TEXT NOT NULL DEFAULT 'project',  -- project | run | card
    target_ref    TEXT,                       -- run_no or task_id when scope != project
    rating        TEXT,                       -- feedback only: good | bad (null for directive)
    author_user_id TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    active        INTEGER NOT NULL DEFAULT 1,
    retired_at    INTEGER,
    superseded_by TEXT                        -- another directive id
);
CREATE INDEX IF NOT EXISTS idx_project_directives_active
    ON project_directives(project_id, active, created_at DESC);

-- The record: one row per occurrence (design §6).
CREATE TABLE IF NOT EXISTS project_runs (
    id            TEXT PRIMARY KEY,
    project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    run_no        INTEGER NOT NULL,
    trigger       TEXT NOT NULL,     -- schedule | manual | event | review
    triggered_by  TEXT,              -- user id, or 'cron:<job_id>'
    profile       TEXT NOT NULL,     -- the host profile the run executed under
    playbook_rev  INTEGER,           -- NULL for a run with no playbook (ad-hoc work)
    status        TEXT NOT NULL,     -- running | waiting | blocked | done | failed | cancelled
    started_at    INTEGER NOT NULL,
    ended_at      INTEGER,
    session_id    TEXT,              -- SessionDB id of the seeded session, when there is one
    trace_id      TEXT,              -- C8 trace; cost and steps are read from it
    outcome       TEXT,              -- one line, machine-set on close
    summary       TEXT,              -- the agent's account of the run
    retro         TEXT,              -- the retrospective; NULL until written
    retro_at      INTEGER,
    score_self    INTEGER,           -- [7] 1–5, the run's own claim, written with the retro
    score_user    INTEGER,           -- [7] 1–5, the human's; only a human may write it
    score_note    TEXT,              -- why that score (the part worth reading)
    scored_by     TEXT,
    scored_at     INTEGER,
    error         TEXT,
    UNIQUE (project_id, run_no)
);
CREATE INDEX IF NOT EXISTS idx_project_runs_recent
    ON project_runs(project_id, run_no DESC);

-- Which cards belong to which run. The mapping lives here so the shared
-- board learns nothing about Projects (no run_id column on tasks).
CREATE TABLE IF NOT EXISTS project_run_cards (
    run_id    TEXT NOT NULL REFERENCES project_runs(id) ON DELETE CASCADE,
    task_id   TEXT NOT NULL,
    step_key  TEXT,                  -- the playbook step it came from, when any
    PRIMARY KEY (run_id, task_id)
);

-- Skill candidates a run's retro proposed (design §8.2 row 3). The row adds
-- no mechanism — the shipped background-review loop still distils skills and
-- FG-29 still promotes them; a project's contribution is *provenance*: the
-- candidate records the project and run it came from.
CREATE TABLE IF NOT EXISTS project_skill_candidates (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    run_no      INTEGER NOT NULL,
    name        TEXT NOT NULL,
    body        TEXT NOT NULL,
    created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_skill_candidates
    ON project_skill_candidates(project_id, created_at DESC);

-- Scope clarification (before implementation): the agent asks the owner
-- questions about goal and scope in rounds; the confirmed understanding and
-- the answers feed the plan draft and every later run's guidance block.
CREATE TABLE IF NOT EXISTS project_clarify_rounds (
    project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    round_no      INTEGER NOT NULL,
    status        TEXT NOT NULL DEFAULT 'open',   -- open | answered | confirmed
    understanding TEXT,                           -- the agent's (or edited) summary
    done          INTEGER NOT NULL DEFAULT 0,     -- agent said it has enough
    focus         TEXT,                           -- what the owner asked it to probe
    created_by    TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    confirmed_by  TEXT,
    confirmed_at  INTEGER,
    PRIMARY KEY (project_id, round_no)
);
CREATE TABLE IF NOT EXISTS project_clarifications (
    id             TEXT PRIMARY KEY,
    project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    round_no       INTEGER NOT NULL,
    position       INTEGER NOT NULL,
    category       TEXT NOT NULL DEFAULT 'other',
    question       TEXT NOT NULL,
    why            TEXT,
    options        TEXT,                          -- JSON list of suggested answers
    allow_multiple INTEGER NOT NULL DEFAULT 0,
    status         TEXT NOT NULL DEFAULT 'open',  -- open | answered | skipped
    answer         TEXT,
    answered_by    TEXT,
    answered_at    INTEGER,
    created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_clarifications
    ON project_clarifications(project_id, round_no, position);
"""


# ---------------------------------------------------------------------------
# Slug + id helpers
# ---------------------------------------------------------------------------

# Lowercase alphanumerics, hyphens, underscores; 1-64 chars; no leading
# separator. Strict enough to stop traversal and path separators, loose enough
# for kebab-case names like ``hermes-agent``. Display formatting (spaces,
# emoji, capitalisation) lives in ``name``; the slug is just a stable handle.
_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9\-_]{0,63}$")


def _slugify(name: str) -> str:
    """Derive a slug candidate from a human name (best-effort)."""
    s = str(name or "").strip().lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-_")
    s = s[:64].strip("-_")
    return s or "project"


def normalize_slug(slug: Optional[str]) -> Optional[str]:
    """Lowercase + strip a slug; validate; return ``None`` for empty."""
    if slug is None:
        return None
    s = str(slug).strip().lower()
    if not s:
        return None
    if not _SLUG_RE.match(s):
        raise ValueError(
            f"invalid project slug {slug!r}: must be 1-64 chars, lowercase "
            f"alphanumerics / hyphens / underscores, not starting with "
            f"'-' or '_'"
        )
    return s


def _new_project_id() -> str:
    return "p_" + secrets.token_hex(4)


def _now() -> int:
    return int(time.time())


def _normalize_path(path: str) -> str:
    """Absolute, user-expanded, separator-normalized path (no trailing sep)."""
    p = os.path.abspath(os.path.expanduser(str(path).strip()))
    return p.rstrip("/\\") or p


# ---------------------------------------------------------------------------
# Connection management
# ---------------------------------------------------------------------------

_INITIALIZED_PATHS: set[str] = set()


def connect(db_path: Optional[Path] = None) -> sqlite3.Connection:
    """Open (and initialize if needed) the shared-root projects DB.

    WAL with DELETE fallback for network filesystems (shared helper from
    ``hermes_state``). Schema init is idempotent (``CREATE TABLE IF NOT
    EXISTS`` + additive migrations) and cached per-path per-process. On the
    first open of the default (root) path per process, legacy per-profile
    stores are imported (:func:`import_profile_stores`).
    """
    path = db_path if db_path is not None else projects_db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    resolved = str(path.resolve())
    conn = sqlite3.connect(str(path))
    try:
        conn.row_factory = sqlite3.Row
        from hermes_state import apply_wal_with_fallback

        apply_wal_with_fallback(conn, db_label="projects.db")
        conn.execute("PRAGMA foreign_keys=ON")
        if resolved not in _INITIALIZED_PATHS:
            conn.executescript(SCHEMA_SQL)
            _migrate_add_optional_columns(conn)
            seed_default_categories(conn)
            if db_path is None:
                # One-shot-per-process import of the legacy per-profile
                # stores. Row-keyed idempotent; a corrupt legacy file must
                # never keep the root store from opening.
                try:
                    import_profile_stores(conn, path.parent)
                except Exception:
                    logger.warning(
                        "projects: legacy profile-store import failed", exc_info=True
                    )
            _INITIALIZED_PATHS.add(resolved)
    except Exception:
        conn.close()
        raise
    return conn


@contextlib.contextmanager
def connect_closing(db_path: Optional[Path] = None):
    """Open a projects DB connection and guarantee it is closed on exit.

    sqlite3's connection context manager only commits/rollbacks; it does NOT
    close the file descriptor. Long-lived processes (gateway, dashboard) route
    many project operations through ``connect()``; without closing, FDs to
    ``projects.db`` accumulate. Mirrors ``kanban_db.connect_closing``.
    """
    conn = connect(db_path=db_path)
    try:
        yield conn
    finally:
        try:
            conn.close()
        except Exception:
            pass


# Columns added to `projects` after v1; re-applied idempotently on every
# open so a legacy DB upgrades in place. (name, full column DDL) pairs —
# SQLite's ADD COLUMN requires a constant default for NOT NULL, which the
# Projects-feature columns (design §2.2) all have.
_PROJECT_COLUMN_MIGRATIONS: tuple[tuple[str, str], ...] = (
    ("board_slug", "board_slug TEXT"),
    ("primary_path", "primary_path TEXT"),
    ("icon", "icon TEXT"),
    ("color", "color TEXT"),
    # Projects feature (2026-08) — the ed.3 additive column set.
    ("goal", "goal TEXT"),
    ("visibility", "visibility TEXT NOT NULL DEFAULT 'shared'"),
    ("owner_user_id", "owner_user_id TEXT"),
    ("status", "status TEXT NOT NULL DEFAULT 'active'"),
    ("cadence", "cadence TEXT NOT NULL DEFAULT 'one_off'"),
    ("schedule", "schedule TEXT"),
    ("review_every", "review_every TEXT"),
    ("autonomy", "autonomy TEXT NOT NULL DEFAULT 'supervised'"),
    ("max_in_progress", "max_in_progress INTEGER NOT NULL DEFAULT 1"),
    ("budget_usd_per_run", "budget_usd_per_run REAL"),
    ("definition_of_done", "definition_of_done TEXT"),
    ("target_audience", "target_audience TEXT"),
    ("score_rubric", "score_rubric TEXT"),
    ("toolsets", "toolsets TEXT"),
    ("skills", "skills TEXT"),
    ("due_at", "due_at INTEGER"),
    ("host_profile", "host_profile TEXT"),
    ("cron_job_id", "cron_job_id TEXT"),
    ("summary", "summary TEXT"),
    ("summary_at", "summary_at INTEGER"),
    ("last_reviewed_at", "last_reviewed_at INTEGER"),
    ("next_run_at", "next_run_at INTEGER"),
    ("imported_from_profile", "imported_from_profile TEXT"),
    ("category_id", "category_id TEXT"),
    ("completed_at", "completed_at INTEGER"),
)


# Columns added to `project_directives` later. `change_meta` is the JSON a
# requirement change carries (kinds, apply mode, draft/approval outcome) —
# NULL on every directive that did not come from the change flow.
_DIRECTIVE_COLUMN_MIGRATIONS: tuple[tuple[str, str], ...] = (
    ("change_meta", "change_meta TEXT"),
)


def _migrate_add_optional_columns(conn: sqlite3.Connection) -> None:
    """Add columns introduced after v1 to legacy DBs (safe on every open)."""
    cols = {row["name"] for row in conn.execute("PRAGMA table_info(projects)")}
    for col, ddl in _PROJECT_COLUMN_MIGRATIONS:
        if col not in cols:
            _add_column_if_missing(conn, "projects", col, ddl)
    dcols = {
        row["name"] for row in conn.execute("PRAGMA table_info(project_directives)")
    }
    for col, ddl in _DIRECTIVE_COLUMN_MIGRATIONS:
        if col not in dcols:
            _add_column_if_missing(conn, "project_directives", col, ddl)
    # Created here, not in SCHEMA_SQL: a legacy DB only has the column once
    # the ADD COLUMN above has run.
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_projects_category ON projects(category_id)"
    )


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------

# Field limits and vocabularies the store enforces (design §2.2). The router
# re-checks them for better error codes; enforcing them here means the CLI
# cannot bypass them.
GOAL_MAX_CHARS = 160
NAME_MAX_CHARS = 60
VALID_PROJECT_STATUSES = (
    "planning", "active", "paused", "done", "archived",
    # Legacy-imported rows land here (L2): they arrive without a goal, outputs
    # or a host profile, so they are quarantined from activation/scheduling
    # until a human completes them.
    "needs_completion",
)
VALID_CADENCES = ("one_off", "repeatable", "standing")
VALID_AUTONOMY_LEVELS = ("manual", "supervised", "autonomous")
VALID_MEMBER_ROLES = ("lead", "member", "viewer")


def _validate_goal(goal: str) -> str:
    """Field [1]: the outcome sentence — non-empty, one sentence, ≤160 chars."""
    g = str(goal or "").strip()
    if not g:
        raise ValueError("project goal must not be empty")
    if len(g) > GOAL_MAX_CHARS:
        raise ValueError(
            f"project goal must be at most {GOAL_MAX_CHARS} chars "
            f"(got {len(g)}): it is one outcome sentence, not the brief"
        )
    return g


def _validate_name(name: str) -> str:
    """The short label — non-empty, ≤60 chars (fits a list row, board, slug)."""
    n = str(name or "").strip()
    if not n:
        raise ValueError("project name must not be empty")
    if len(n) > NAME_MAX_CHARS:
        raise ValueError(
            f"project name must be at most {NAME_MAX_CHARS} chars (got {len(n)})"
        )
    return n


def default_name_from_goal(goal: str) -> str:
    """Derive the short label from the goal's leading clause (design §2.2).

    Leading clause = text before the first ``—``, ``:`` or ``.``; failing
    that, the first six words. Truncated to ``NAME_MAX_CHARS``. Never tracks
    the goal afterwards — the two are edited independently.
    """
    g = str(goal or "").strip()
    for sep in ("—", ":", "."):
        idx = g.find(sep)
        if idx > 0:
            g = g[:idx]
            break
    else:
        words = g.split()
        if len(words) > 6:
            g = " ".join(words[:6])
    return g.strip()[:NAME_MAX_CHARS].strip()


VALID_VISIBILITIES = ("shared", "private")


def _validate_cadence(value: str) -> str:
    v = str(value or "").strip()
    if v not in VALID_CADENCES:
        raise ValueError(f"cadence must be one of {sorted(VALID_CADENCES)}")
    return v


def _validate_autonomy(value: str) -> str:
    v = str(value or "").strip()
    if v not in VALID_AUTONOMY_LEVELS:
        raise ValueError(f"autonomy must be one of {sorted(VALID_AUTONOMY_LEVELS)}")
    return v


def _validate_visibility(value: str) -> str:
    v = str(value or "").strip()
    if v not in VALID_VISIBILITIES:
        raise ValueError(f"visibility must be one of {sorted(VALID_VISIBILITIES)}")
    return v


def _validate_max_in_progress(value) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("max_in_progress must be an integer") from exc
    if n < 1:
        raise ValueError("max_in_progress must be >= 1")
    return n


def _opt_str(value) -> Optional[str]:
    if value is None:
        return None
    s = str(value).strip()
    return s or None


def _opt_int(value) -> Optional[int]:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("expected an integer") from exc


def _opt_float(value) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("expected a number") from exc


@dataclass
class ProjectFolder:
    path: str
    label: Optional[str] = None
    is_primary: bool = False
    added_at: int = 0

    def to_dict(self) -> dict:
        return {
            "path": self.path,
            "label": self.label,
            "is_primary": bool(self.is_primary),
            "added_at": self.added_at,
        }


@dataclass
class Project:
    id: str
    slug: str
    name: str
    created_at: int
    description: Optional[str] = None
    icon: Optional[str] = None
    color: Optional[str] = None
    board_slug: Optional[str] = None
    primary_path: Optional[str] = None
    archived: bool = False
    folders: List[ProjectFolder] = field(default_factory=list)
    # Projects-feature columns (design §2.2). Defaults match the additive
    # column defaults so legacy rows and new rows read identically.
    goal: Optional[str] = None
    visibility: str = "shared"
    owner_user_id: Optional[str] = None
    status: str = "active"
    cadence: str = "one_off"
    schedule: Optional[str] = None
    review_every: Optional[str] = None
    autonomy: str = "supervised"
    max_in_progress: int = 1
    budget_usd_per_run: Optional[float] = None
    definition_of_done: Optional[str] = None
    target_audience: Optional[str] = None
    score_rubric: Optional[str] = None
    toolsets: Optional[str] = None
    skills: Optional[str] = None
    due_at: Optional[int] = None
    host_profile: Optional[str] = None
    cron_job_id: Optional[str] = None
    summary: Optional[str] = None
    summary_at: Optional[int] = None
    last_reviewed_at: Optional[int] = None
    next_run_at: Optional[int] = None
    imported_from_profile: Optional[str] = None
    category_id: Optional[str] = None
    # Stamped when the project moves to ``done``; cleared when it reopens.
    completed_at: Optional[int] = None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "slug": self.slug,
            "name": self.name,
            "description": self.description,
            "icon": self.icon,
            "color": self.color,
            "board_slug": self.board_slug,
            "primary_path": self.primary_path,
            "archived": bool(self.archived),
            "created_at": self.created_at,
            "folders": [f.to_dict() for f in self.folders],
            "goal": self.goal,
            "visibility": self.visibility,
            "owner_user_id": self.owner_user_id,
            "status": self.status,
            "cadence": self.cadence,
            "schedule": self.schedule,
            "review_every": self.review_every,
            "autonomy": self.autonomy,
            "max_in_progress": self.max_in_progress,
            "budget_usd_per_run": self.budget_usd_per_run,
            "definition_of_done": self.definition_of_done,
            "target_audience": self.target_audience,
            "score_rubric": self.score_rubric,
            "toolsets": self.toolsets,
            "skills": self.skills,
            "due_at": self.due_at,
            "host_profile": self.host_profile,
            "cron_job_id": self.cron_job_id,
            "summary": self.summary,
            "summary_at": self.summary_at,
            "last_reviewed_at": self.last_reviewed_at,
            "next_run_at": self.next_run_at,
            "imported_from_profile": self.imported_from_profile,
            "category_id": self.category_id,
            "completed_at": self.completed_at,
        }


def _row_get(row: sqlite3.Row, key: str, default=None):
    """Read ``row[key]`` when the column exists (legacy DB tolerance)."""
    return row[key] if key in row.keys() else default


def _project_from_row(row: sqlite3.Row) -> Project:
    return Project(
        id=row["id"],
        slug=row["slug"],
        name=row["name"],
        created_at=row["created_at"],
        description=_row_get(row, "description"),
        icon=_row_get(row, "icon"),
        color=_row_get(row, "color"),
        board_slug=_row_get(row, "board_slug"),
        primary_path=_row_get(row, "primary_path"),
        archived=bool(_row_get(row, "archived", 0)),
        goal=_row_get(row, "goal"),
        visibility=_row_get(row, "visibility", "shared") or "shared",
        owner_user_id=_row_get(row, "owner_user_id"),
        status=_row_get(row, "status", "active") or "active",
        cadence=_row_get(row, "cadence", "one_off") or "one_off",
        schedule=_row_get(row, "schedule"),
        review_every=_row_get(row, "review_every"),
        autonomy=_row_get(row, "autonomy", "supervised") or "supervised",
        max_in_progress=int(_row_get(row, "max_in_progress", 1) or 1),
        budget_usd_per_run=_row_get(row, "budget_usd_per_run"),
        definition_of_done=_row_get(row, "definition_of_done"),
        target_audience=_row_get(row, "target_audience"),
        score_rubric=_row_get(row, "score_rubric"),
        toolsets=_row_get(row, "toolsets"),
        skills=_row_get(row, "skills"),
        due_at=_row_get(row, "due_at"),
        host_profile=_row_get(row, "host_profile"),
        cron_job_id=_row_get(row, "cron_job_id"),
        summary=_row_get(row, "summary"),
        summary_at=_row_get(row, "summary_at"),
        last_reviewed_at=_row_get(row, "last_reviewed_at"),
        next_run_at=_row_get(row, "next_run_at"),
        imported_from_profile=_row_get(row, "imported_from_profile"),
        category_id=_row_get(row, "category_id"),
        completed_at=_row_get(row, "completed_at"),
    )


def _load_folders(conn: sqlite3.Connection, project_id: str) -> List[ProjectFolder]:
    rows = conn.execute(
        "SELECT path, label, is_primary, added_at FROM project_folders "
        "WHERE project_id = ? ORDER BY is_primary DESC, added_at ASC",
        (project_id,),
    ).fetchall()
    return [
        ProjectFolder(
            path=r["path"],
            label=r["label"],
            is_primary=bool(r["is_primary"]),
            added_at=r["added_at"],
        )
        for r in rows
    ]


def _attach_folders(conn: sqlite3.Connection, project: Project) -> Project:
    project.folders = _load_folders(conn, project.id)
    return project


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------


def _unique_slug(conn: sqlite3.Connection, candidate: str) -> str:
    """Return ``candidate`` or ``candidate-2``, ``-3`` ... if taken."""
    base = candidate
    n = 1
    slug = base
    while conn.execute(
        "SELECT 1 FROM projects WHERE slug = ?", (slug,)
    ).fetchone() is not None:
        n += 1
        suffix = f"-{n}"
        slug = (base[: 64 - len(suffix)]).rstrip("-_") + suffix
    return slug


def create_project(
    conn: sqlite3.Connection,
    *,
    name: str,
    slug: Optional[str] = None,
    folders: Optional[Iterable[str]] = None,
    primary_path: Optional[str] = None,
    description: Optional[str] = None,
    icon: Optional[str] = None,
    color: Optional[str] = None,
    board_slug: Optional[str] = None,
    goal: Optional[str] = None,
    owner_user_id: Optional[str] = None,
    category_id: Optional[str] = None,
) -> str:
    """Create a project and return its id.

    The low-level writer, kept for the legacy workspace surfaces (the
    desktop's session grouping, ``hermes project``). Full Projects-feature
    creates go through :func:`create_full_project`, which enforces the
    mandatory fields [1]–[4].

    ``folders`` are normalized to absolute paths. If ``primary_path`` is given
    it is added to the folder set (if not already present) and marked primary;
    otherwise the first folder becomes primary.
    """
    name = _validate_name(name)
    validated_goal = _validate_goal(goal) if goal is not None else None

    slug_candidate = normalize_slug(slug) if slug else _slugify(name)
    pid = _new_project_id()
    now = _now()

    folder_paths: List[str] = []
    for f in folders or []:
        norm = _normalize_path(f)
        if norm and norm not in folder_paths:
            folder_paths.append(norm)

    primary = _normalize_path(primary_path) if primary_path else None
    if primary and primary not in folder_paths:
        folder_paths.insert(0, primary)
    if primary is None and folder_paths:
        primary = folder_paths[0]

    with write_txn(conn):
        category = _resolve_category_id(conn, category_id)
        unique = _unique_slug(conn, slug_candidate)
        conn.execute(
            "INSERT INTO projects "
            "(id, slug, name, description, icon, color, board_slug, "
            " primary_path, created_at, archived, goal, owner_user_id, "
            " category_id) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)",
            (
                pid,
                unique,
                name,
                description,
                icon,
                color,
                normalize_slug(board_slug) if board_slug else None,
                primary,
                now,
                validated_goal,
                owner_user_id,
                category,
            ),
        )
        for path in folder_paths:
            conn.execute(
                "INSERT INTO project_folders "
                "(project_id, path, label, is_primary, added_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (pid, path, None, 1 if path == primary else 0, now),
            )
    return pid


def create_full_project(
    conn: sqlite3.Connection,
    *,
    goal: str,
    description: str,
    name: Optional[str] = None,
    slug: Optional[str] = None,
    folders: Optional[Iterable[str]] = None,
    primary_path: Optional[str] = None,
    icon: Optional[str] = None,
    color: Optional[str] = None,
    board_slug: Optional[str] = None,
    owner_user_id: Optional[str] = None,
    cadence: str = "one_off",
    autonomy: str = "supervised",
    category_id: Optional[str] = None,
) -> str:
    """Create a project under the full §2.2 contract and return its id.

    Mandatory: ``goal`` [1] (non-empty, ≤160) and ``description`` [2]
    (non-empty). ``name`` defaults from the goal's leading clause and is
    independently editable afterwards. The row lands in ``planning`` — it
    may only leave once the caller has written at least one output [3], one
    member and one profile [4] (:func:`set_project_status` enforces the
    gate). Outputs/members/profiles are written through their own helpers so
    the caller controls their rows.
    """
    validated_goal = _validate_goal(goal)
    desc = str(description or "").strip()
    if not desc:
        raise ValueError("project description must not be empty")
    if cadence not in VALID_CADENCES:
        raise ValueError(f"cadence must be one of {sorted(VALID_CADENCES)}")
    if autonomy not in VALID_AUTONOMY_LEVELS:
        raise ValueError(f"autonomy must be one of {sorted(VALID_AUTONOMY_LEVELS)}")

    label = _validate_name(name) if name else default_name_from_goal(validated_goal)
    if not label:
        raise ValueError("project name must not be empty")

    pid = create_project(
        conn,
        name=label,
        slug=slug,
        folders=folders,
        primary_path=primary_path,
        description=desc,
        icon=icon,
        color=color,
        board_slug=board_slug,
        goal=validated_goal,
        owner_user_id=owner_user_id,
        category_id=category_id,
    )
    with write_txn(conn):
        conn.execute(
            "UPDATE projects SET status = 'planning', cadence = ?, autonomy = ? "
            "WHERE id = ?",
            (cadence, autonomy, pid),
        )
    return pid


def list_projects(
    conn: sqlite3.Connection, *, include_archived: bool = False
) -> List[Project]:
    sql = "SELECT * FROM projects"
    if not include_archived:
        sql += " WHERE archived = 0"
    sql += " ORDER BY created_at ASC"
    rows = conn.execute(sql).fetchall()
    return [_attach_folders(conn, _project_from_row(r)) for r in rows]


def get_project(
    conn: sqlite3.Connection, id_or_slug: str
) -> Optional[Project]:
    """Look up a project by id first, then by slug."""
    row = conn.execute(
        "SELECT * FROM projects WHERE id = ?", (id_or_slug,)
    ).fetchone()
    if row is None:
        row = conn.execute(
            "SELECT * FROM projects WHERE slug = ?", (str(id_or_slug).lower(),)
        ).fetchone()
    if row is None:
        return None
    return _attach_folders(conn, _project_from_row(row))


def update_project(
    conn: sqlite3.Connection,
    project_id: str,
    *,
    name: Optional[str] = None,
    goal: Optional[str] = None,
    description: Optional[str] = None,
    icon: Optional[str] = None,
    color: Optional[str] = None,
    board_slug: Optional[str] = None,
) -> bool:
    """Patch top-level project fields. Only provided fields change.

    ``name`` and ``goal`` are independent fields (design decision 11):
    re-wording the goal never silently renames the project, and renaming
    never rewrites the goal.

    ``icon``, ``color``, and ``board_slug`` accept an empty string to clear
    (store NULL) — passing ``None`` leaves the field untouched, so callers that
    want to clear must send ``""``.
    """
    sets: List[str] = []
    params: List[object] = []
    if name is not None:
        sets.append("name = ?")
        params.append(_validate_name(name))
    if goal is not None:
        sets.append("goal = ?")
        params.append(_validate_goal(goal))
    if description is not None:
        sets.append("description = ?")
        params.append(description)
    if icon is not None:
        sets.append("icon = ?")
        params.append(icon or None)
    if color is not None:
        sets.append("color = ?")
        params.append(color or None)
    if board_slug is not None:
        sets.append("board_slug = ?")
        params.append(normalize_slug(board_slug) if board_slug.strip() else None)
    if not sets:
        return False
    params.append(project_id)
    with write_txn(conn):
        cur = conn.execute(
            f"UPDATE projects SET {', '.join(sets)} WHERE id = ?", params
        )
    return cur.rowcount > 0


def update_project_fields(
    conn: sqlite3.Connection,
    project_id: str,
    fields: dict,
) -> bool:
    """Patch the §2.2 record fields :func:`update_project` does not cover.

    ``status`` is intentionally NOT accepted here — status transitions go
    through :func:`set_project_status`, which owns the planning-exit gate.
    Unknown fields raise ``ValueError`` so a router typo is loud.
    """
    writers = {
        "cadence": lambda v: _validate_cadence(v),
        "due_at": _opt_int,
        "review_every": _opt_str,
        "target_audience": _opt_str,
        "score_rubric": _opt_str,
        "visibility": _validate_visibility,
        "definition_of_done": _opt_str,
        "max_in_progress": _validate_max_in_progress,
        "budget_usd_per_run": _opt_float,
        "autonomy": lambda v: _validate_autonomy(v),
        # §4.1 instruments: stored as comma lists; the narrowing
        # intersection happens at run spawn time, never at write time.
        "toolsets": _opt_str,
        "skills": _opt_str,
        # §3.2 schedule wiring: the cron store is authoritative; these are
        # the project-side halves of the link (``schedule`` text, the job
        # id in the host profile's store, and the ``next_run_at`` display
        # cache refreshed on read).
        "schedule": _opt_str,
        "cron_job_id": _opt_str,
        "next_run_at": _opt_int,
    }
    sets: List[str] = []
    params: List[Any] = []
    for key, value in fields.items():
        if key == "status":
            raise ValueError(
                "status changes go through set_project_status (the "
                "planning-exit gate)"
            )
        if key not in writers:
            raise ValueError(f"unknown project field: {key!r}")
        sets.append(f"{key} = ?")
        params.append(writers[key](value))
    if not sets:
        return False
    params.append(project_id)
    with write_txn(conn):
        cur = conn.execute(
            f"UPDATE projects SET {', '.join(sets)} WHERE id = ?", params
        )
    return cur.rowcount > 0


def _needs_completion_missing(
    conn: sqlite3.Connection, project_id: str, goal: Optional[str]
) -> List[str]:
    """The L2 quarantine's missing mandatory fields (§2.2), named in one
    place: the status-set gate and the archive gate refuse with the same
    sentence."""
    missing: List[str] = []
    if not str(goal or "").strip():
        missing.append("a goal")
    if not conn.execute(
        "SELECT COUNT(*) AS n FROM project_outputs WHERE project_id = ?",
        (project_id,),
    ).fetchone()["n"]:
        missing.append("at least one output")
    if not conn.execute(
        "SELECT COUNT(*) AS n FROM project_profiles "
        "WHERE project_id = ? AND role = 'host'",
        (project_id,),
    ).fetchone()["n"]:
        missing.append("a host profile")
    return missing


def set_project_status(
    conn: sqlite3.Connection, project_id: str, status: str
) -> bool:
    """Move a project between statuses, enforcing the §2.2 exit gate.

    Leaving ``planning`` requires at least one output [3], one member and
    one profile [4] — declaring the deliverable after automating its
    production is how you get a run that succeeds at nothing. The error
    names every missing piece.
    """
    if status not in VALID_PROJECT_STATUSES:
        raise ValueError(f"status must be one of {sorted(VALID_PROJECT_STATUSES)}")
    with write_txn(conn):
        row = conn.execute(
            "SELECT status, goal FROM projects WHERE id = ?", (project_id,)
        ).fetchone()
        if row is None:
            return False
        if row["status"] == "planning" and status != "planning":
            missing: List[str] = []
            for table, label in (
                ("project_outputs", "at least one output"),
                ("project_members", "at least one member"),
                ("project_profiles", "at least one profile"),
            ):
                count = conn.execute(
                    f"SELECT COUNT(*) AS n FROM {table} WHERE project_id = ?",
                    (project_id,),
                ).fetchone()["n"]
                if not count:
                    missing.append(label)
            if missing:
                raise ValueError(
                    f"project {project_id} cannot leave 'planning': missing "
                    + ", ".join(missing)
                )
        if row["status"] == "needs_completion" and status != "needs_completion":
            # L2: an imported legacy project must be completed before it can
            # live — the gate names every missing mandatory field, the same
            # shape as the planning-exit gate above.
            missing = _needs_completion_missing(conn, project_id, row["goal"])
            if missing:
                raise ValueError(
                    f"project {project_id} was imported from a legacy store "
                    "and needs completion before it can leave "
                    f"'needs_completion': missing " + ", ".join(missing)
                )
        # ``done`` stamps the completion date (kept through archiving);
        # reopening the project clears it.
        if status == "done":
            completed_sql = "completed_at = COALESCE(completed_at, ?)"
            completed_arg: Optional[int] = _now()
            if row["status"] != "done":
                completed_sql = "completed_at = ?"
        elif status == "archived":
            completed_sql = "completed_at = COALESCE(completed_at, ?)"
            completed_arg = None
        else:
            completed_sql = "completed_at = ?"
            completed_arg = None
        cur = conn.execute(
            f"UPDATE projects SET status = ?, {completed_sql} WHERE id = ?",
            (status, completed_arg, project_id),
        )
    return cur.rowcount > 0


def set_project_summary(
    conn: sqlite3.Connection, project_id: str, summary: str
) -> Optional[int]:
    """Write the rolling \"where this stands\" (§2.2) and stamp ``summary_at``.

    The one write entry point for ``summary`` — ``update_project_fields``
    deliberately does not accept it, so the audit line (who summarised,
    when) has exactly one place to come from. Returns ``summary_at``, or
    ``None`` if the project does not exist.
    """
    summary = str(summary or "").strip()
    if not summary:
        raise ValueError("summary must not be empty")
    now = _now()
    with write_txn(conn):
        cur = conn.execute(
            "UPDATE projects SET summary = ?, summary_at = ? WHERE id = ?",
            (summary, now, project_id),
        )
    return now if cur.rowcount > 0 else None


# ---------------------------------------------------------------------------
# project_members (people on the project; profiles live in project_profiles)
# ---------------------------------------------------------------------------


def add_project_member(
    conn: sqlite3.Connection,
    *,
    project_id: str,
    user_id: str,
    role: str = "member",
    added_by: Optional[str] = None,
) -> bool:
    """Add a member. Returns False if already a member."""
    user_id = str(user_id or "").strip()
    if not user_id:
        raise ValueError("member user_id must not be empty")
    if role not in VALID_MEMBER_ROLES:
        raise ValueError(f"member role must be one of {sorted(VALID_MEMBER_ROLES)}")
    now = _now()
    with write_txn(conn):
        cur = conn.execute(
            "INSERT OR IGNORE INTO project_members "
            "(project_id, user_id, role, added_by, added_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (project_id, user_id, role, added_by, now),
        )
    return cur.rowcount > 0


def get_project_members(
    conn: sqlite3.Connection, project_id: str
) -> List[dict]:
    """Read ``project_members`` rows, leads first, then by added_at."""
    rows = conn.execute(
        "SELECT * FROM project_members WHERE project_id = ? "
        "ORDER BY CASE role WHEN 'lead' THEN 0 WHEN 'member' THEN 1 ELSE 2 END, "
        "added_at ASC",
        (project_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def remove_project_member(
    conn: sqlite3.Connection, project_id: str, user_id: str
) -> bool:
    with write_txn(conn):
        cur = conn.execute(
            "DELETE FROM project_members WHERE project_id = ? AND user_id = ?",
            (project_id, user_id),
        )
    return cur.rowcount > 0


def add_folder(
    conn: sqlite3.Connection,
    project_id: str,
    path: str,
    *,
    label: Optional[str] = None,
    is_primary: bool = False,
) -> str:
    """Add a folder to a project. Returns the normalized path.

    When ``is_primary`` is set, the folder becomes the project's primary repo
    (the previous primary is demoted, and ``projects.primary_path`` updates).
    """
    norm = _normalize_path(path)
    if not norm:
        raise ValueError("folder path must not be empty")
    if get_project(conn, project_id) is None:
        raise ValueError(f"no such project: {project_id}")
    now = _now()
    with write_txn(conn):
        conn.execute(
            "INSERT OR IGNORE INTO project_folders "
            "(project_id, path, label, is_primary, added_at) "
            "VALUES (?, ?, ?, 0, ?)",
            (project_id, norm, label, now),
        )
        if label is not None:
            conn.execute(
                "UPDATE project_folders SET label = ? "
                "WHERE project_id = ? AND path = ?",
                (label, project_id, norm),
            )
        if is_primary:
            _set_primary_locked(conn, project_id, norm)
        else:
            # First folder of an empty project becomes primary implicitly.
            existing_primary = conn.execute(
                "SELECT 1 FROM project_folders "
                "WHERE project_id = ? AND is_primary = 1",
                (project_id,),
            ).fetchone()
            if existing_primary is None:
                _set_primary_locked(conn, project_id, norm)
    return norm


def remove_folder(conn: sqlite3.Connection, project_id: str, path: str) -> bool:
    """Remove a folder from a project. Repoints primary if it was primary."""
    norm = _normalize_path(path)
    with write_txn(conn):
        was_primary = conn.execute(
            "SELECT is_primary FROM project_folders "
            "WHERE project_id = ? AND path = ?",
            (project_id, norm),
        ).fetchone()
        cur = conn.execute(
            "DELETE FROM project_folders WHERE project_id = ? AND path = ?",
            (project_id, norm),
        )
        if was_primary is not None and was_primary["is_primary"]:
            nxt = conn.execute(
                "SELECT path FROM project_folders WHERE project_id = ? "
                "ORDER BY added_at ASC LIMIT 1",
                (project_id,),
            ).fetchone()
            new_primary = nxt["path"] if nxt else None
            if new_primary:
                _set_primary_locked(conn, project_id, new_primary)
            else:
                conn.execute(
                    "UPDATE projects SET primary_path = NULL WHERE id = ?",
                    (project_id,),
                )
    return cur.rowcount > 0


def _set_primary_locked(
    conn: sqlite3.Connection, project_id: str, path: str
) -> None:
    """Set the primary folder (caller already holds a write txn)."""
    conn.execute(
        "UPDATE project_folders SET is_primary = 0 WHERE project_id = ?",
        (project_id,),
    )
    conn.execute(
        "UPDATE project_folders SET is_primary = 1 "
        "WHERE project_id = ? AND path = ?",
        (project_id, path),
    )
    conn.execute(
        "UPDATE projects SET primary_path = ? WHERE id = ?",
        (path, project_id),
    )


def set_primary(conn: sqlite3.Connection, project_id: str, path: str) -> bool:
    norm = _normalize_path(path)
    with write_txn(conn):
        exists = conn.execute(
            "SELECT 1 FROM project_folders WHERE project_id = ? AND path = ?",
            (project_id, norm),
        ).fetchone()
        if exists is None:
            return False
        _set_primary_locked(conn, project_id, norm)
    return True


def archive_project(conn: sqlite3.Connection, project_id: str) -> bool:
    """Shelve a project (§12, decision 17): ``archived=1`` **and**
    ``status='archived'`` in one transaction — the two flags are one state
    and must never disagree.

    A ``needs_completion`` project cannot be shelved either (L2): complete
    the record first — the refusal names the missing mandatory fields with
    the same sentence the status-set gate uses.
    """
    with write_txn(conn):
        row = conn.execute(
            "SELECT status, goal FROM projects WHERE id = ?", (project_id,)
        ).fetchone()
        if row is None:
            return False
        if row["status"] == "needs_completion":
            missing = _needs_completion_missing(conn, project_id, row["goal"])
            if missing:
                raise ValueError(
                    f"project {project_id} was imported from a legacy store "
                    "and needs completion before it can be archived: missing "
                    + ", ".join(missing)
                )
        cur = conn.execute(
            "UPDATE projects SET archived = 1, status = 'archived' "
            "WHERE id = ?",
            (project_id,),
        )
    return cur.rowcount > 0


def restore_project(conn: sqlite3.Connection, project_id: str) -> bool:
    """Bring a shelved project back: ``archived=0``, ``status='paused'``.

    Deliberately not straight to ``active`` (§12): re-entry is a decision,
    and ``paused`` keeps the §2.2 exit gate meaningful. The schedule is not
    re-created — ``PUT /schedule`` does that.
    """
    with write_txn(conn):
        cur = conn.execute(
            "UPDATE projects SET archived = 0, status = 'paused' "
            "WHERE id = ?",
            (project_id,),
        )
    return cur.rowcount > 0


def delete_project(conn: sqlite3.Connection, project_id: str) -> bool:
    """Hard-delete a project and its folders (cascade)."""
    with write_txn(conn):
        cur = conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))
    return cur.rowcount > 0


# ---------------------------------------------------------------------------
# Project categories (the /projects board columns)
# ---------------------------------------------------------------------------

CATEGORY_NAME_MAX_CHARS = 40
CATEGORY_COLOR_MAX_CHARS = 64
DEFAULT_CATEGORY_NAMES = ("Sales", "Marketing", "Research", "Operations")
_CATEGORIES_SEEDED_META_KEY = "project_categories_seeded"
_UNSET: Any = object()


class CategoryNameTaken(ValueError):
    """Another category already has this name (case-insensitive)."""


def _validate_category_name(name: Any) -> str:
    if not isinstance(name, str):
        raise ValueError("category name must be a string")
    label = name.strip()
    if not label:
        raise ValueError("category name must not be empty")
    if len(label) > CATEGORY_NAME_MAX_CHARS:
        raise ValueError(
            f"category name must be at most {CATEGORY_NAME_MAX_CHARS} characters"
        )
    return label


def _validate_category_color(color: Any) -> Optional[str]:
    if color is None:
        return None
    if not isinstance(color, str):
        raise ValueError("category color must be a string or null")
    value = color.strip()
    if len(value) > CATEGORY_COLOR_MAX_CHARS:
        raise ValueError(
            f"category color must be at most {CATEGORY_COLOR_MAX_CHARS} characters"
        )
    return value or None


def _validate_category_position(position: Any) -> int:
    if isinstance(position, bool) or not isinstance(position, int):
        raise ValueError("category position must be an integer")
    return position


def _check_category_name_free(
    conn: sqlite3.Connection, name: str, *, exclude_id: Optional[str] = None
) -> None:
    row = conn.execute(
        "SELECT id FROM project_categories WHERE lower(name) = lower(?) AND id != ?",
        (name, exclude_id or ""),
    ).fetchone()
    if row is not None:
        raise CategoryNameTaken(f"a category named {name!r} already exists")


def _resolve_category_id(conn: sqlite3.Connection, value: Any) -> Optional[str]:
    """``None``/``""`` clear; any other value must name an existing category."""
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("category_id must be a string or null")
    cid = value.strip()
    if not cid:
        return None
    if conn.execute(
        "SELECT 1 FROM project_categories WHERE id = ?", (cid,)
    ).fetchone() is None:
        raise ValueError(f"unknown project category: {cid!r}")
    return cid


_CATEGORY_SELECT = (
    "SELECT c.id, c.name, c.color, c.position, c.created_at, c.created_by, "
    "(SELECT COUNT(*) FROM projects p WHERE p.category_id = c.id) AS project_count "
    "FROM project_categories c"
)


def _category_from_row(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "color": row["color"],
        "position": int(row["position"]),
        "created_at": row["created_at"],
        "created_by": row["created_by"],
        "project_count": int(row["project_count"]),
    }


def list_categories(conn: sqlite3.Connection) -> List[dict]:
    """Every category in column order, each with its project count
    (archived projects included)."""
    rows = conn.execute(
        _CATEGORY_SELECT + " ORDER BY c.position ASC, c.created_at ASC, c.id ASC"
    ).fetchall()
    return [_category_from_row(r) for r in rows]


def get_category(conn: sqlite3.Connection, category_id: str) -> Optional[dict]:
    row = conn.execute(
        _CATEGORY_SELECT + " WHERE c.id = ?", (category_id,)
    ).fetchone()
    return _category_from_row(row) if row is not None else None


def _insert_category(
    conn: sqlite3.Connection,
    *,
    name: str,
    color: Optional[str],
    position: int,
    created_by: Optional[str],
) -> str:
    cid = _new_row_id("pcat")
    try:
        conn.execute(
            "INSERT INTO project_categories "
            "(id, name, color, position, created_by, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (cid, name, color, position, created_by, _now()),
        )
    except sqlite3.IntegrityError as exc:
        raise CategoryNameTaken(f"a category named {name!r} already exists") from exc
    return cid


def create_category(
    conn: sqlite3.Connection,
    *,
    name: Any,
    color: Any = None,
    created_by: Optional[str] = None,
) -> dict:
    """Add a category at the end of the column order (``max(position) + 1``).

    Raises :class:`CategoryNameTaken` for a duplicate name and ``ValueError``
    for an invalid name/color.
    """
    label = _validate_category_name(name)
    tone = _validate_category_color(color)
    with write_txn(conn):
        _check_category_name_free(conn, label)
        row = conn.execute(
            "SELECT MAX(position) AS m FROM project_categories"
        ).fetchone()
        position = 0 if row["m"] is None else int(row["m"]) + 1
        cid = _insert_category(
            conn, name=label, color=tone, position=position, created_by=created_by
        )
    category = get_category(conn, cid)
    assert category is not None
    return category


def update_category(
    conn: sqlite3.Connection,
    category_id: str,
    *,
    name: Any = _UNSET,
    color: Any = _UNSET,
    position: Any = _UNSET,
) -> Optional[dict]:
    """Rename / recolour / reorder. Only provided fields change; ``color=None``
    clears. Returns the category, or ``None`` when ``category_id`` is unknown.
    """
    sets: List[str] = []
    params: List[Any] = []
    label = None
    if name is not _UNSET:
        label = _validate_category_name(name)
        sets.append("name = ?")
        params.append(label)
    if color is not _UNSET:
        sets.append("color = ?")
        params.append(_validate_category_color(color))
    if position is not _UNSET:
        sets.append("position = ?")
        params.append(_validate_category_position(position))
    with write_txn(conn):
        if conn.execute(
            "SELECT 1 FROM project_categories WHERE id = ?", (category_id,)
        ).fetchone() is None:
            return None
        if sets:
            if label is not None:
                _check_category_name_free(conn, label, exclude_id=category_id)
            try:
                conn.execute(
                    f"UPDATE project_categories SET {', '.join(sets)} WHERE id = ?",
                    (*params, category_id),
                )
            except sqlite3.IntegrityError as exc:
                raise CategoryNameTaken(
                    f"a category named {label!r} already exists"
                ) from exc
    return get_category(conn, category_id)


def delete_category(conn: sqlite3.Connection, category_id: str) -> Optional[int]:
    """Delete a category; its projects become Uncategorized in the same
    transaction. Returns how many projects were reset, or ``None`` when
    ``category_id`` is unknown."""
    with write_txn(conn):
        if conn.execute(
            "SELECT 1 FROM project_categories WHERE id = ?", (category_id,)
        ).fetchone() is None:
            return None
        cur = conn.execute(
            "UPDATE projects SET category_id = NULL WHERE category_id = ?",
            (category_id,),
        )
        reset = cur.rowcount
        conn.execute("DELETE FROM project_categories WHERE id = ?", (category_id,))
    return reset


def set_project_category(
    conn: sqlite3.Connection, project_id: str, category_id: Any
) -> bool:
    """File a project under a category (``None``/``""`` = Uncategorized).
    An unknown category id raises ``ValueError``."""
    with write_txn(conn):
        cid = _resolve_category_id(conn, category_id)
        cur = conn.execute(
            "UPDATE projects SET category_id = ? WHERE id = ?", (cid, project_id)
        )
    return cur.rowcount > 0


def seed_default_categories(conn: sqlite3.Connection) -> bool:
    """Seed :data:`DEFAULT_CATEGORY_NAMES` once per projects DB.

    Guarded by a ``project_meta`` flag rather than "table is empty", so a
    user who deletes every category never gets them back. Names that already
    exist are skipped. Returns whether this call seeded.
    """
    with write_txn(conn):
        if conn.execute(
            "SELECT 1 FROM project_meta WHERE key = ?", (_CATEGORIES_SEEDED_META_KEY,)
        ).fetchone() is not None:
            return False
        row = conn.execute(
            "SELECT MAX(position) AS m FROM project_categories"
        ).fetchone()
        position = 0 if row["m"] is None else int(row["m"]) + 1
        for name in DEFAULT_CATEGORY_NAMES:
            if conn.execute(
                "SELECT 1 FROM project_categories WHERE lower(name) = lower(?)",
                (name,),
            ).fetchone() is not None:
                continue
            _insert_category(
                conn, name=name, color=None, position=position, created_by=None
            )
            position += 1
        conn.execute(
            "INSERT INTO project_meta (key, value) VALUES (?, ?)",
            (_CATEGORIES_SEEDED_META_KEY, str(_now())),
        )
    return True


# ---------------------------------------------------------------------------
# Active-project pointer (project_meta KV)
# ---------------------------------------------------------------------------


_ACTIVE_META_KEY = "active_id"


def set_active(conn: sqlite3.Connection, project_id: Optional[str]) -> None:
    """Set (or clear, when ``None``) the active project pointer."""
    with write_txn(conn):
        if project_id is None:
            conn.execute("DELETE FROM project_meta WHERE key = ?", (_ACTIVE_META_KEY,))
        else:
            conn.execute(
                "INSERT INTO project_meta (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (_ACTIVE_META_KEY, project_id),
            )


def get_active_id(conn: sqlite3.Connection) -> Optional[str]:
    row = conn.execute(
        "SELECT value FROM project_meta WHERE key = ?", (_ACTIVE_META_KEY,)
    ).fetchone()
    return row["value"] if row else None


# ---------------------------------------------------------------------------
# Discovered repos (filesystem scan cache)
# ---------------------------------------------------------------------------


def record_discovered_repos(
    conn: sqlite3.Connection,
    repos: Iterable[tuple[str, Optional[str]]],
    *,
    replace: bool = False,
) -> int:
    """Persist scanned git repo roots into the cache.

    ``repos`` is an iterable of ``(root, label)``. Roots are normalized; the
    label falls back to the basename. Returns the number of rows written.

    When ``replace`` is true, this is the authoritative result of a fresh disk
    scan: delete stale rows first so old eval/worktree noise disappears instead
    of living forever in the cache.
    """
    now = _now()
    rows = []
    for root, label in repos:
        norm = _normalize_path(root)
        if not norm:
            continue
        rows.append((norm, (label or os.path.basename(norm) or norm), now))

    with write_txn(conn):
        if replace:
            conn.execute("DELETE FROM discovered_repos")
        if rows:
            conn.executemany(
                "INSERT INTO discovered_repos (root, label, last_seen) VALUES (?, ?, ?) "
                "ON CONFLICT(root) DO UPDATE SET label = excluded.label, "
                "last_seen = excluded.last_seen",
                rows,
            )
    return len(rows)


def list_discovered_repos(conn: sqlite3.Connection) -> List[dict]:
    """All cached discovered repo roots, most-recently-seen first."""
    rows = conn.execute(
        "SELECT root, label, last_seen FROM discovered_repos ORDER BY last_seen DESC"
    ).fetchall()
    return [
        {"root": r["root"], "label": r["label"], "last_seen": r["last_seen"]}
        for r in rows
    ]


# ---------------------------------------------------------------------------
# Resolution + naming
# ---------------------------------------------------------------------------


def project_for_path(
    conn: sqlite3.Connection, path: str, *, include_archived: bool = False
) -> Optional[Project]:
    """Return the project owning ``path`` (longest-prefix folder match).

    A folder owns ``path`` when ``path`` equals the folder or is nested under
    it. The most specific (longest) folder wins, so nested projects resolve to
    the innermost one.
    """
    if not str(path or "").strip():
        return None
    target = _normalize_path(path)
    sql = (
        "SELECT pf.project_id AS pid, pf.path AS folder "
        "FROM project_folders pf JOIN projects p ON p.id = pf.project_id"
    )
    if not include_archived:
        sql += " WHERE p.archived = 0"
    best_pid: Optional[str] = None
    best_len = -1
    for row in conn.execute(sql).fetchall():
        folder = row["folder"]
        if target == folder or target.startswith(folder.rstrip("/\\") + os.sep) or \
                target.startswith(folder.rstrip("/\\") + "/"):
            if len(folder) > best_len:
                best_len = len(folder)
                best_pid = row["pid"]
    if best_pid is None:
        return None
    return get_project(conn, best_pid)


# Deterministic branch slug: lowercase, separators collapsed, capped.
_BRANCH_SAFE_RE = re.compile(r"[^a-z0-9._-]+")


def branch_name_for(project: Project, task_id: str, *, title: str = "") -> str:
    """Deterministic branch name for a project-linked kanban task.

    Shape: ``<project-slug>/<task-id>`` (optionally ``-<title-slug>``). Stable
    and human-meaningful, replacing the random ``wt/<task-id>`` fallback.
    """
    slug = project.slug or _slugify(project.name)
    base = f"{slug}/{task_id}"
    if title:
        tslug = _BRANCH_SAFE_RE.sub("-", str(title).strip().lower()).strip("-")
        tslug = tslug[:40].strip("-")
        if tslug:
            base = f"{base}-{tslug}"
    return base


# ---------------------------------------------------------------------------
# project_links + project_profiles (the Projects page link table)
# ---------------------------------------------------------------------------

def add_project_link(
    conn: sqlite3.Connection,
    *,
    project_id: str,
    kind: str,
    profile: str,
    ref: str,
    label: Optional[str] = None,
    added_by: Optional[str] = None,
) -> bool:
    """Write a ``project_links`` row. Returns False on PK conflict (already linked).

    A link is a pointer, never a copy — the authority stays in the profile
    that owns the referenced object. Re-inserting the same link is a no-op.
    """
    if kind not in VALID_LINK_KINDS:
        raise ValueError(f"link kind must be one of {sorted(VALID_LINK_KINDS)}")
    now = int(time.time())
    with write_txn(conn):
        cur = conn.execute(
            """INSERT OR IGNORE INTO project_links
               (project_id, kind, profile, ref, label, added_by, added_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (project_id, kind, profile, ref, label, added_by, now),
        )
    return cur.rowcount > 0


def get_project_links(
    conn: sqlite3.Connection,
    project_id: str,
    *,
    kind: Optional[str] = None,
) -> List[dict]:
    """Read ``project_links`` rows, newest first."""
    sql = "SELECT * FROM project_links WHERE project_id = ?"
    params: list = [project_id]
    if kind:
        sql += " AND kind = ?"
        params.append(kind)
    sql += " ORDER BY added_at DESC"
    return [dict(r) for r in conn.execute(sql, params).fetchall()]


def add_project_profile(
    conn: sqlite3.Connection,
    *,
    project_id: str,
    profile: str,
    role: str = "member",
    added_by: Optional[str] = None,
) -> bool:
    """Add a profile to a project. Returns False if already a member."""
    now = int(time.time())
    with write_txn(conn):
        cur = conn.execute(
            """INSERT OR IGNORE INTO project_profiles
               (project_id, profile, role, added_by, added_at)
               VALUES (?, ?, ?, ?, ?)""",
            (project_id, profile, role, added_by, now),
        )
    return cur.rowcount > 0


def get_project_profiles(
    conn: sqlite3.Connection,
    project_id: str,
) -> List[dict]:
    """Read ``project_profiles`` rows."""
    return [
        dict(r)
        for r in conn.execute(
            "SELECT * FROM project_profiles WHERE project_id = ?",
            (project_id,),
        ).fetchall()
    ]


def remove_project_profile(
    conn: sqlite3.Connection, project_id: str, profile: str
) -> bool:
    """Detach a profile from a project. The caller owns the guardrails
    (the API refuses to detach the last one); the store just removes."""
    with write_txn(conn):
        cur = conn.execute(
            "DELETE FROM project_profiles WHERE project_id = ? AND profile = ?",
            (project_id, profile),
        )
    return cur.rowcount > 0


# ---------------------------------------------------------------------------
# Outputs, deliveries, contacts (design §2.2 / §6.1; API step 3)
# ---------------------------------------------------------------------------

VALID_LINK_KINDS = (
    "file", "arrival", "todo", "goal", "memory",
    "conversation", "sample", "reference", "url",
    # FG-33 2.8: an app (``tools.name``) linked to the project.
    "tool",
)
VALID_OUTPUT_KINDS = ("artifact", "file", "message", "decision", "report", "code")
VALID_OUTPUT_STATUSES = ("pending", "in_progress", "delivered", "accepted", "dropped")


def _new_row_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(6)}"


_LITERAL_UNICODE_ESCAPE = re.compile(r"\\u([0-9a-fA-F]{4})")


def decode_literal_unicode_escapes(text: Optional[str]) -> Optional[str]:
    """Turn literal ``\\uXXXX`` sequences back into the characters they name.

    Output titles/specs written by an agent through the CLI or a JSON body
    that was encoded twice arrive as ``\\u9752\\u7530…`` instead of CJK
    text. Decoding is idempotent and leaves text without escapes untouched;
    surrogate pairs are joined, lone surrogates are left as written.
    """
    if not text or "\\u" not in text:
        return text

    def _decode(match: "re.Match[str]") -> str:
        return chr(int(match.group(1), 16))

    decoded = _LITERAL_UNICODE_ESCAPE.sub(_decode, text)
    try:
        return decoded.encode("utf-16", "surrogatepass").decode("utf-16")
    except UnicodeDecodeError:
        return text


def _decode_output_row(row: dict) -> dict:
    for key in ("title", "spec"):
        if isinstance(row.get(key), str):
            row[key] = decode_literal_unicode_escapes(row[key])
    return row


def add_project_output(
    conn: sqlite3.Connection,
    *,
    project_id: str,
    title: str,
    spec: Optional[str] = None,
    kind: str = "artifact",
    required: bool = True,
    recurring: bool = False,
) -> str:
    """Declare a deliverable [3]. Returns the new output id.

    ``seq`` is assigned after the current last row, so outputs list in
    declaration order. Declaring the deliverable before automating its
    production is what keeps a run from succeeding at nothing (§6.1).
    """
    title = decode_literal_unicode_escapes(str(title or "").strip()) or ""
    spec = decode_literal_unicode_escapes(spec)
    if not title:
        raise ValueError("output title is required")
    if kind not in VALID_OUTPUT_KINDS:
        raise ValueError(f"output kind must be one of {sorted(VALID_OUTPUT_KINDS)}")
    oid = _new_row_id("o")
    now = _now()
    with write_txn(conn):
        row = conn.execute(
            "SELECT COALESCE(MAX(seq), 0) AS m FROM project_outputs "
            "WHERE project_id = ?",
            (project_id,),
        ).fetchone()
        conn.execute(
            """INSERT INTO project_outputs
               (id, project_id, seq, title, spec, kind, required, recurring,
                status, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)""",
            (oid, project_id, int(row["m"]) + 1, title, spec, kind,
             1 if required else 0, 1 if recurring else 0, now),
        )
    return oid


def get_project_outputs(
    conn: sqlite3.Connection, project_id: str
) -> List[dict]:
    """Read a project's outputs in declaration order."""
    return [
        _decode_output_row(dict(r))
        for r in conn.execute(
            "SELECT * FROM project_outputs WHERE project_id = ? ORDER BY seq",
            (project_id,),
        ).fetchall()
    ]


def update_project_output(
    conn: sqlite3.Connection,
    output_id: str,
    *,
    title: Optional[str] = None,
    spec: Optional[str] = None,
    kind: Optional[str] = None,
    required: Optional[bool] = None,
    recurring: Optional[bool] = None,
    status: Optional[str] = None,
) -> bool:
    """Patch an output row. Setting ``status='delivered'`` stamps
    ``delivered_at``; ``accepted`` is reserved for :func:`accept_project_output`
    (only a human accepts — §6.1)."""
    sets: List[str] = []
    params: List[Any] = []
    if title is not None:
        t = str(title).strip()
        if not t:
            raise ValueError("output title cannot be empty")
        sets.append("title = ?")
        params.append(decode_literal_unicode_escapes(t))
    if spec is not None:
        sets.append("spec = ?")
        params.append(decode_literal_unicode_escapes(spec))
    if kind is not None:
        if kind not in VALID_OUTPUT_KINDS:
            raise ValueError(f"output kind must be one of {sorted(VALID_OUTPUT_KINDS)}")
        sets.append("kind = ?")
        params.append(kind)
    if required is not None:
        sets.append("required = ?")
        params.append(1 if required else 0)
    if recurring is not None:
        sets.append("recurring = ?")
        params.append(1 if recurring else 0)
    if status is not None:
        if status not in VALID_OUTPUT_STATUSES or status == "accepted":
            raise ValueError(
                "output status must be one of "
                f"{sorted(s for s in VALID_OUTPUT_STATUSES if s != 'accepted')}; "
                "acceptance goes through the human-only accept route"
            )
        sets.append("status = ?")
        params.append(status)
        if status == "delivered":
            sets.append("delivered_at = ?")
            params.append(_now())
    if not sets:
        return False
    params.append(output_id)
    with write_txn(conn):
        cur = conn.execute(
            f"UPDATE project_outputs SET {', '.join(sets)} WHERE id = ?", params
        )
    return cur.rowcount > 0


def accept_project_output(
    conn: sqlite3.Connection,
    output_id: str,
    *,
    accepted_by: str,
) -> bool:
    """Human-only acceptance (§6.1): the run may deliver, only a person
    accepts. Accepting a ``recurring`` output stamps the acceptance but the
    row's deliveries keep accumulating."""
    with write_txn(conn):
        cur = conn.execute(
            "UPDATE project_outputs SET status = 'accepted', accepted_at = ?, "
            "accepted_by = ? WHERE id = ? AND status != 'dropped'",
            (_now(), accepted_by, output_id),
        )
    return cur.rowcount > 0


def remove_project_output(conn: sqlite3.Connection, output_id: str) -> bool:
    """Delete an output row — refused for the last required output.

    A project's outputs are the denominator its progress is measured in;
    silently emptying it would turn every later run into effort mistaken
    for delivery (§15.9).
    """
    with write_txn(conn):
        row = conn.execute(
            "SELECT project_id, required FROM project_outputs WHERE id = ?",
            (output_id,),
        ).fetchone()
        if row is None:
            return False
        if row["required"]:
            others = conn.execute(
                "SELECT COUNT(*) AS n FROM project_outputs "
                "WHERE project_id = ? AND required = 1 AND id != ?",
                (row["project_id"], output_id),
            ).fetchone()["n"]
            if not others:
                raise ValueError(
                    "refusing to delete the last required output; declare a "
                    "replacement first or drop the project"
                )
        conn.execute("DELETE FROM project_outputs WHERE id = ?", (output_id,))
    return True


def record_output_delivery(
    conn: sqlite3.Connection,
    *,
    output_id: str,
    run_id: Optional[str] = None,
    task_id: Optional[str] = None,
    link_kind: Optional[str] = None,
    link_ref: Optional[str] = None,
    profile: Optional[str] = None,
    label: Optional[str] = None,
    note: Optional[str] = None,
) -> str:
    """One delivery row per produced output (§6.1). Recurring outputs
    accumulate one row per run. A web link recorded without a kind is a
    ``url`` delivery. A delivery made from a run's card (``task_id`` set,
    ``run_id`` not) is filed under that card's run, so the run's outcome
    counts it."""
    if not link_kind and link_ref and urlparse(link_ref).scheme in ("http", "https"):
        link_kind = "url"
    did = _new_row_id("d")
    with write_txn(conn):
        output = conn.execute(
            "SELECT project_id FROM project_outputs WHERE id = ?", (output_id,)
        ).fetchone()
        if output is None:
            raise ValueError(f"unknown output: {output_id!r}")
        if task_id and not run_id:
            owner = conn.execute(
                "SELECT r.id FROM project_run_cards c "
                "JOIN project_runs r ON r.id = c.run_id "
                "WHERE c.task_id = ? AND r.project_id = ?",
                (task_id, output["project_id"]),
            ).fetchone()
            if owner is not None:
                run_id = owner["id"]
        conn.execute(
            """INSERT INTO project_output_deliveries
               (id, output_id, run_id, task_id, link_kind, link_ref, profile,
                label, note, delivered_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (did, output_id, run_id, task_id, link_kind, link_ref, profile,
             label, note, _now()),
        )
    return did


def get_output_deliveries(
    conn: sqlite3.Connection,
    *,
    output_id: Optional[str] = None,
    project_id: Optional[str] = None,
    run_id: Optional[str] = None,
) -> List[dict]:
    """Deliveries for one output, one run, or a whole project, newest first."""
    if output_id is not None:
        rows = conn.execute(
            "SELECT * FROM project_output_deliveries WHERE output_id = ? "
            "ORDER BY delivered_at DESC, id DESC",
            (output_id,),
        ).fetchall()
    elif run_id is not None:
        rows = conn.execute(
            "SELECT * FROM project_output_deliveries WHERE run_id = ? "
            "ORDER BY delivered_at DESC, id DESC",
            (run_id,),
        ).fetchall()
    elif project_id is not None:
        rows = conn.execute(
            "SELECT d.* FROM project_output_deliveries d "
            "JOIN project_outputs o ON o.id = d.output_id "
            "WHERE o.project_id = ? ORDER BY d.delivered_at DESC, d.id DESC",
            (project_id,),
        ).fetchall()
    else:
        raise ValueError("output_id or project_id is required")
    return [dict(r) for r in rows]


def add_project_contact(
    conn: sqlite3.Connection,
    *,
    project_id: str,
    name: str,
    role: Optional[str] = None,
    org: Optional[str] = None,
    platform: Optional[str] = None,
    address: Optional[str] = None,
    user_id: Optional[str] = None,
    notes: Optional[str] = None,
    created_by: Optional[str] = None,
) -> str:
    """Add a contact [10]. ``address`` is PII: members-only in responses."""
    name = str(name or "").strip()
    if not name:
        raise ValueError("contact name is required")
    cid = _new_row_id("c")
    with write_txn(conn):
        conn.execute(
            """INSERT INTO project_contacts
               (id, project_id, name, role, org, platform, address, user_id,
                notes, created_by, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (cid, project_id, name, role, org, platform, address, user_id,
             notes, created_by, _now()),
        )
    return cid


def get_project_contacts(
    conn: sqlite3.Connection, project_id: str
) -> List[dict]:
    """Read a project's contacts, newest first."""
    return [
        dict(r)
        for r in conn.execute(
            "SELECT * FROM project_contacts WHERE project_id = ? "
            "ORDER BY created_at DESC",
            (project_id,),
        ).fetchall()
    ]


def update_project_contact(
    conn: sqlite3.Connection,
    contact_id: str,
    **fields: Any,
) -> bool:
    """Patch contact fields (name, role, org, platform, address, user_id,
    notes). Unknown fields are refused."""
    allowed = {"name", "role", "org", "platform", "address", "user_id", "notes"}
    sets: List[str] = []
    params: List[Any] = []
    for key, value in fields.items():
        if key not in allowed:
            raise ValueError(f"unknown contact field: {key!r}")
        if key == "name" and not str(value or "").strip():
            raise ValueError("contact name cannot be empty")
        sets.append(f"{key} = ?")
        params.append(value)
    if not sets:
        return False
    params.append(contact_id)
    with write_txn(conn):
        cur = conn.execute(
            f"UPDATE project_contacts SET {', '.join(sets)} WHERE id = ?",
            params,
        )
    return cur.rowcount > 0


def remove_project_contact(conn: sqlite3.Connection, contact_id: str) -> bool:
    with write_txn(conn):
        cur = conn.execute(
            "DELETE FROM project_contacts WHERE id = ?", (contact_id,)
        )
    return cur.rowcount > 0


def remove_project_link(
    conn: sqlite3.Connection,
    *,
    project_id: str,
    kind: str,
    profile: str,
    ref: str,
) -> bool:
    """Detach a link pointer. The referenced object is never touched."""
    with write_txn(conn):
        cur = conn.execute(
            "DELETE FROM project_links "
            "WHERE project_id = ? AND kind = ? AND profile = ? AND ref = ?",
            (project_id, kind, profile, ref),
        )
    return cur.rowcount > 0


# ---------------------------------------------------------------------------
# Playbook (design §7)
# ---------------------------------------------------------------------------

VALID_STEP_MODES = ("card", "inline")


def validate_playbook_steps(steps: Any) -> List[dict]:
    """Validate a ``steps`` array **at save time** (design §7.1).

    Refuses the whole array with the offending keys named: missing/blank
    ``key`` or ``title``, duplicate keys, an unknown ``mode``, and a
    ``depends_on`` graph that is cyclic or references an unknown key. A
    cycle discovered at 09:00 on Monday is a silent no-run, so the refusal
    happens when the method is written, not when it fires.
    """
    if not isinstance(steps, list):
        raise ValueError("playbook steps must be a JSON array")
    seen: set = set()
    cleaned: List[dict] = []
    for i, step in enumerate(steps):
        if not isinstance(step, dict):
            raise ValueError(f"step #{i + 1} must be an object")
        key = str(step.get("key") or "").strip()
        if not key:
            raise ValueError(f"step #{i + 1} has no key")
        if key in seen:
            raise ValueError(f"duplicate step key: {key!r}")
        seen.add(key)
        title = str(step.get("title") or "").strip()
        if not title:
            raise ValueError(f"step {key!r} has no title")
        mode = str(step.get("mode") or "card").strip()
        if mode not in VALID_STEP_MODES:
            raise ValueError(
                f"step {key!r}: mode must be one of {sorted(VALID_STEP_MODES)}"
            )
        deps = step.get("depends_on") or []
        if not isinstance(deps, list):
            raise ValueError(f"step {key!r}: depends_on must be an array")
        ts = step.get("toolsets") or []
        if not isinstance(ts, list) or any(
            not isinstance(t, str) or not t.strip() or "," in t for t in ts
        ):
            raise ValueError(
                f"step {key!r}: toolsets must be an array of toolset names "
                "(e.g. [\"file\", \"terminal\"]) — the step's worker loads "
                "only these plus the core floor; leave it out to give the "
                "worker the profile's full tool surface"
            )
        cleaned.append(
            {
                "key": key,
                "title": title,
                "body": str(step.get("body") or ""),
                "mode": mode,
                "assignee": step.get("assignee"),
                "depends_on": [str(d) for d in deps],
                "checkpoint": bool(step.get("checkpoint")),
                # Narrow the card worker's tool surface (fewer tool schemas
                # per model call). Names not enabled by the host profile are
                # dropped at run start and recorded on the run (§4.1) — a
                # plan may legitimately name sets only some profiles enable.
                "toolsets": [t.strip() for t in ts],
            }
        )

    for step in cleaned:
        for dep in step["depends_on"]:
            if dep not in seen:
                raise ValueError(
                    f"step {step['key']!r} depends on unknown key {dep!r}"
                )

    # Cycle detection (iterative DFS), naming the keys on the cycle path.
    WHITE, GRAY, BLACK = 0, 1, 2
    color = {s["key"]: WHITE for s in cleaned}
    deps_of = {s["key"]: s["depends_on"] for s in cleaned}

    def _visit(root: str) -> None:
        stack = [(root, iter(deps_of[root]))]
        path = [root]
        color[root] = GRAY
        while stack:
            node, it = stack[-1]
            advanced = False
            for dep in it:
                if color[dep] == GRAY:
                    cycle = path[path.index(dep):] + [dep]
                    raise ValueError(
                        "playbook steps contain a cycle: "
                        + " -> ".join(cycle)
                    )
                if color[dep] == WHITE:
                    color[dep] = GRAY
                    path.append(dep)
                    stack.append((dep, iter(deps_of[dep])))
                    advanced = True
                    break
            if not advanced:
                color[node] = BLACK
                path.pop()
                stack.pop()

    for step in cleaned:
        if color[step["key"]] == WHITE:
            _visit(step["key"])
    return cleaned


def save_playbook_rev(
    conn: sqlite3.Connection,
    *,
    project_id: str,
    body: str = "",
    steps: Any,
    created_by: Optional[str] = None,
    note: Optional[str] = None,
) -> int:
    """Create playbook revision N+1 with ``active=0`` (design §7.2).

    A new revision is a proposal: it changes nothing until a human
    activates it, and a running run keeps its pinned rev either way.
    Returns the new rev number.
    """
    cleaned = validate_playbook_steps(steps)
    with write_txn(conn):
        row = conn.execute(
            "SELECT COALESCE(MAX(rev), 0) AS m FROM project_playbook "
            "WHERE project_id = ?",
            (project_id,),
        ).fetchone()
        rev = int(row["m"]) + 1
        conn.execute(
            """INSERT INTO project_playbook
               (project_id, rev, body, steps, active, created_by, created_at, note)
               VALUES (?, ?, ?, ?, 0, ?, ?, ?)""",
            (project_id, rev, str(body or ""), json.dumps(cleaned),
             created_by, _now(), note),
        )
    return rev


def activate_playbook_rev(
    conn: sqlite3.Connection,
    project_id: str,
    rev: int,
    *,
    note: Optional[str] = None,
) -> bool:
    """Human-only activation (§7.2): exactly one rev is active at a time."""
    with write_txn(conn):
        exists = conn.execute(
            "SELECT 1 FROM project_playbook WHERE project_id = ? AND rev = ?",
            (project_id, rev),
        ).fetchone()
        if exists is None:
            return False
        conn.execute(
            "UPDATE project_playbook SET active = 0, activated_at = NULL "
            "WHERE project_id = ?",
            (project_id,),
        )
        conn.execute(
            "UPDATE project_playbook SET active = 1, activated_at = ?, "
            "note = COALESCE(?, note) WHERE project_id = ? AND rev = ?",
            (_now(), note, project_id, rev),
        )
    return True


def discard_playbook_rev(
    conn: sqlite3.Connection, project_id: str, rev: int
) -> Optional[str]:
    """Delete a proposed (inactive) playbook revision — the human deciding
    this draft is wrong, paired with activation (§7.2).

    Returns ``None`` on success, else a refusal: ``"not_found"``,
    ``"active"`` (the live plan cannot be discarded), or
    ``"pinned:<run_no>"`` — a rev a run pinned is that run's recorded plan
    and stays for history even if it is no longer active."""
    with write_txn(conn):
        row = conn.execute(
            "SELECT active FROM project_playbook WHERE project_id = ? AND rev = ?",
            (project_id, rev),
        ).fetchone()
        if row is None:
            return "not_found"
        if row["active"]:
            return "active"
        pinned = conn.execute(
            "SELECT run_no FROM project_runs "
            "WHERE project_id = ? AND playbook_rev = ? LIMIT 1",
            (project_id, rev),
        ).fetchone()
        if pinned is not None:
            return f"pinned:{pinned['run_no']}"
        conn.execute(
            "DELETE FROM project_playbook WHERE project_id = ? AND rev = ?",
            (project_id, rev),
        )
    return None


def get_playbook(
    conn: sqlite3.Connection,
    project_id: str,
    rev: Optional[int] = None,
) -> Optional[dict]:
    """One playbook revision; ``rev=None`` returns the active one."""
    if rev is None:
        row = conn.execute(
            "SELECT * FROM project_playbook WHERE project_id = ? AND active = 1",
            (project_id,),
        ).fetchone()
    else:
        row = conn.execute(
            "SELECT * FROM project_playbook WHERE project_id = ? AND rev = ?",
            (project_id, int(rev)),
        ).fetchone()
    if row is None:
        return None
    d = dict(row)
    try:
        d["steps"] = json.loads(d.get("steps") or "[]")
    except (TypeError, ValueError):
        d["steps"] = []
    return d


def list_playbook_revs(conn: sqlite3.Connection, project_id: str) -> List[dict]:
    rows = conn.execute(
        "SELECT project_id, rev, body, steps, active, created_by, created_at, "
        "activated_at, note FROM project_playbook WHERE project_id = ? "
        "ORDER BY rev DESC",
        (project_id,),
    ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        try:
            d["steps"] = json.loads(d.get("steps") or "[]")
        except (TypeError, ValueError):
            d["steps"] = []
        out.append(d)
    return out


# ---------------------------------------------------------------------------
# Directives (design §5)
# ---------------------------------------------------------------------------

VALID_DIRECTIVE_KINDS = ("directive", "feedback")
VALID_DIRECTIVE_SCOPES = ("project", "run", "card")


def add_project_directive(
    conn: sqlite3.Connection,
    *,
    project_id: str,
    kind: str,
    body: str,
    scope: str = "project",
    target_ref: Optional[str] = None,
    rating: Optional[str] = None,
    author_user_id: str,
    max_active: int = 20,
    active: bool = True,
) -> str:
    """Add guidance (§5). The active set is capped: adding directive N+1 is
    refused with *retire one first* — a monotonically growing instruction
    list is a tax on every run (§5.2).

    ``active=False`` proposes the directive (§8.2): it lands inactive and
    consumes no cap slot until a member activates it."""
    if kind not in VALID_DIRECTIVE_KINDS:
        raise ValueError(f"kind must be one of {sorted(VALID_DIRECTIVE_KINDS)}")
    if scope not in VALID_DIRECTIVE_SCOPES:
        raise ValueError(f"scope must be one of {sorted(VALID_DIRECTIVE_SCOPES)}")
    text = str(body or "").strip()
    if not text:
        raise ValueError("directive body must not be empty")
    if not str(author_user_id or "").strip():
        raise ValueError("author_user_id is required")
    if rating is not None and rating not in ("good", "bad"):
        raise ValueError("rating must be 'good' or 'bad'")
    with write_txn(conn):
        if active:
            n = conn.execute(
                "SELECT COUNT(*) AS n FROM project_directives "
                "WHERE project_id = ? AND active = 1",
                (project_id,),
            ).fetchone()["n"]
            if n >= max_active:
                raise ValueError(
                    f"directive cap reached ({max_active} active): retire one first"
                )
        did = _new_row_id("dir")
        conn.execute(
            """INSERT INTO project_directives
               (id, project_id, kind, body, scope, target_ref, rating,
                author_user_id, created_at, active)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (did, project_id, kind, text, scope, target_ref, rating,
             str(author_user_id).strip(), _now(), 1 if active else 0),
        )
    return did


def activate_project_directive(
    conn: sqlite3.Connection,
    directive_id: str,
    *,
    max_active: int = 20,
) -> bool:
    """Activate a **proposed** directive (§8.2): any member may cross it.

    Only rows that were proposed (``active=0`` and never retired) can be
    activated; the active-set cap is enforced at the crossing, not at
    proposal time. Returns False when there is nothing to activate.
    Raises ValueError when the cap blocks the crossing."""
    with write_txn(conn):
        row = conn.execute(
            "SELECT project_id FROM project_directives "
            "WHERE id = ? AND active = 0 AND retired_at IS NULL",
            (directive_id,),
        ).fetchone()
        if row is None:
            return False
        n = conn.execute(
            "SELECT COUNT(*) AS n FROM project_directives "
            "WHERE project_id = ? AND active = 1",
            (row["project_id"],),
        ).fetchone()["n"]
        if n >= max_active:
            raise ValueError(
                f"directive cap reached ({max_active} active): retire one first"
            )
        conn.execute(
            "UPDATE project_directives SET active = 1 WHERE id = ?",
            (directive_id,),
        )
    return True


def retire_project_directive(conn: sqlite3.Connection, directive_id: str) -> bool:
    """Retire, never delete (§5.2): the record of what the agent was told
    when run 9 executed must survive."""
    with write_txn(conn):
        cur = conn.execute(
            "UPDATE project_directives SET active = 0, retired_at = ? "
            "WHERE id = ? AND active = 1",
            (_now(), directive_id),
        )
    return cur.rowcount > 0


def list_project_directives(
    conn: sqlite3.Connection,
    project_id: str,
    *,
    active_only: bool = True,
) -> List[dict]:
    sql = "SELECT * FROM project_directives WHERE project_id = ?"
    if active_only:
        sql += " AND active = 1"
    # Newest first; ``rowid`` breaks same-second ties in insertion order so
    # a later instruction visibly wins (§5.2).
    sql += " ORDER BY created_at DESC, rowid DESC"
    return [dict(r) for r in conn.execute(sql, (project_id,)).fetchall()]


def list_proposed_directives(
    conn: sqlite3.Connection,
    project_id: str,
) -> List[dict]:
    """Proposed-but-inactive directives (§8.2): ``active=0`` and never
    retired — the rows a run's retro proposed, waiting for a member."""
    rows = conn.execute(
        "SELECT * FROM project_directives "
        "WHERE project_id = ? AND active = 0 AND retired_at IS NULL "
        "ORDER BY created_at DESC, rowid DESC",
        (project_id,),
    ).fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Skill candidates (design §8.2 row 3) — provenance only, no mechanism
# ---------------------------------------------------------------------------


def add_skill_candidate(
    conn: sqlite3.Connection,
    *,
    project_id: str,
    run_no: int,
    name: str,
    body: str,
) -> str:
    """Record a skill a run's retro proposed. The row is pure provenance —
    it records the project and run the candidate came from; the shipped
    skills loop (§8.2) does the distilling and promoting."""
    candidate_name = str(name or "").strip()
    if not candidate_name:
        raise ValueError("skill candidate name must not be empty")
    text = str(body or "").strip()
    if not text:
        raise ValueError("skill candidate body must not be empty")
    cid = _new_row_id("skc")
    with write_txn(conn):
        conn.execute(
            """INSERT INTO project_skill_candidates
               (id, project_id, run_no, name, body, created_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (cid, project_id, int(run_no), candidate_name, text, _now()),
        )
    return cid


def list_skill_candidates(
    conn: sqlite3.Connection,
    project_id: str,
) -> List[dict]:
    rows = conn.execute(
        "SELECT * FROM project_skill_candidates WHERE project_id = ? "
        "ORDER BY created_at DESC, rowid DESC",
        (project_id,),
    ).fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Runs (design §6)
# ---------------------------------------------------------------------------

VALID_RUN_TRIGGERS = ("schedule", "manual", "event", "review")
VALID_RUN_STATUSES = (
    "running", "waiting", "blocked", "done", "failed", "cancelled",
)


class RunAlreadyOpen(ValueError):
    """A project holds at most one ``running``/``waiting`` run at a time."""

    def __init__(self, run_no: int, status: str):
        self.run_no = run_no
        self.status = status
        state = "is still running" if status == "running" else "is waiting for you"
        super().__init__(
            f"run {run_no} {state} — finish, continue or cancel it before "
            "starting another"
        )


def open_project_run(
    conn: sqlite3.Connection,
    *,
    project_id: str,
    trigger: str,
    triggered_by: Optional[str] = None,
    profile: str,
    playbook_rev: Optional[int] = None,
    trace_id: Optional[str] = None,
) -> dict:
    """Open the run row: ``run_no = max+1``, status ``running`` (§6).

    Raises :class:`RunAlreadyOpen` while another run of the project is
    ``running`` or ``waiting``; checked inside the write transaction so two
    concurrent starts cannot both open one."""
    if trigger not in VALID_RUN_TRIGGERS:
        raise ValueError(f"trigger must be one of {sorted(VALID_RUN_TRIGGERS)}")
    if not str(profile or "").strip():
        raise ValueError("run profile is required")
    rid = _new_row_id("run")
    with write_txn(conn):
        open_runs = list_open_project_runs(conn, project_id)
        if open_runs:
            raise RunAlreadyOpen(open_runs[0]["run_no"], open_runs[0]["status"])
        row = conn.execute(
            "SELECT COALESCE(MAX(run_no), 0) AS m FROM project_runs "
            "WHERE project_id = ?",
            (project_id,),
        ).fetchone()
        run_no = int(row["m"]) + 1
        conn.execute(
            """INSERT INTO project_runs
               (id, project_id, run_no, trigger, triggered_by, profile,
                playbook_rev, status, started_at, trace_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)""",
            (rid, project_id, run_no, trigger, triggered_by,
             str(profile).strip(), playbook_rev, _now(), trace_id),
        )
    return get_project_run_by_id(conn, rid)


def get_project_run_by_id(
    conn: sqlite3.Connection, run_id: str
) -> Optional[dict]:
    row = conn.execute(
        "SELECT * FROM project_runs WHERE id = ?", (run_id,)
    ).fetchone()
    return dict(row) if row else None


def get_project_run(
    conn: sqlite3.Connection, project_id: str, run_no: int
) -> Optional[dict]:
    row = conn.execute(
        "SELECT * FROM project_runs WHERE project_id = ? AND run_no = ?",
        (project_id, int(run_no)),
    ).fetchone()
    return dict(row) if row else None


def list_project_runs(
    conn: sqlite3.Connection, project_id: str, *, limit: int = 50
) -> List[dict]:
    return [
        dict(r)
        for r in conn.execute(
            "SELECT * FROM project_runs WHERE project_id = ? "
            "ORDER BY run_no DESC LIMIT ?",
            (project_id, int(limit)),
        ).fetchall()
    ]


def list_open_project_runs(
    conn: sqlite3.Connection, project_id: str
) -> List[dict]:
    """Every resumable run — no limit, no ordering assumption (U10).

    The archive precondition cannot page: ``list_project_runs`` reads the
    NEWEST 50, so a long-standing project would hide an old run stuck at
    a checkpoint from the gate. Ask in SQL instead."""
    return [
        dict(r)
        for r in conn.execute(
            "SELECT run_no, status FROM project_runs "
            "WHERE project_id = ? AND status IN ('running', 'waiting') "
            "ORDER BY run_no",
            (project_id,),
        ).fetchall()
    ]


def last_scored_runs(
    conn: sqlite3.Connection, project_id: str, *, limit: int = 5
) -> List[dict]:
    """§8.1: the last *scored* runs — the window is scores, not runs (E5).

    A standing project with twenty-five unscored recent runs still reports
    the mean of its last five scores; selecting scored rows first keeps the
    score from silently disappearing behind an unscored streak.
    """
    return [
        dict(r)
        for r in conn.execute(
            "SELECT * FROM project_runs WHERE project_id = ? "
            "AND score_user IS NOT NULL ORDER BY run_no DESC LIMIT ?",
            (project_id, int(limit)),
        ).fetchall()
    ]


def latest_waiting_run(
    conn: sqlite3.Connection, project_id: str
) -> Optional[dict]:
    """The newest run held at ``waiting``, however old (F5) — the detail
    brief must never truncate the one a human still has to resume."""
    row = conn.execute(
        "SELECT * FROM project_runs WHERE project_id = ? "
        "AND status = 'waiting' ORDER BY run_no DESC LIMIT 1",
        (project_id,),
    ).fetchone()
    return dict(row) if row is not None else None


_RUN_PATCH_FIELDS = {
    "status", "session_id", "trace_id", "outcome", "summary", "retro",
    "retro_at", "score_self", "score_user", "score_note", "scored_by",
    "scored_at", "error", "ended_at",
}


def update_project_run(
    conn: sqlite3.Connection, run_id: str, **fields: Any
) -> bool:
    """Patch run fields. ``score_user`` is NOT writable through this
    helper's callers in the router for agent principals — the human-only
    rule is enforced at the seam (§16)."""
    sets: List[str] = []
    params: List[Any] = []
    for key, value in fields.items():
        if key not in _RUN_PATCH_FIELDS:
            raise ValueError(f"unknown run field: {key!r}")
        if key == "status" and value not in VALID_RUN_STATUSES:
            raise ValueError(f"status must be one of {sorted(VALID_RUN_STATUSES)}")
        sets.append(f"{key} = ?")
        params.append(value)
    if not sets:
        return False
    params.append(run_id)
    with write_txn(conn):
        cur = conn.execute(
            f"UPDATE project_runs SET {', '.join(sets)} WHERE id = ?", params
        )
    return cur.rowcount > 0


def close_project_run(
    conn: sqlite3.Connection,
    run_id: str,
    *,
    status: str,
    outcome: Optional[str] = None,
    summary: Optional[str] = None,
    error: Optional[str] = None,
) -> bool:
    """Close a run: terminal status + machine-set outcome (§6.1)."""
    if status not in ("done", "failed", "cancelled", "blocked"):
        raise ValueError("a run closes into done | failed | cancelled | blocked")
    return update_project_run(
        conn,
        run_id,
        status=status,
        outcome=outcome,
        summary=summary,
        error=error,
        ended_at=_now(),
    )


def link_run_card(
    conn: sqlite3.Connection,
    run_id: str,
    task_id: str,
    step_key: Optional[str] = None,
) -> bool:
    """Record that a card belongs to a run — the mapping lives here so the
    shared board learns nothing about Projects (no run_id on tasks)."""
    with write_txn(conn):
        cur = conn.execute(
            "INSERT OR IGNORE INTO project_run_cards (run_id, task_id, step_key) "
            "VALUES (?, ?, ?)",
            (run_id, task_id, step_key),
        )
    return cur.rowcount > 0


def get_run_cards(conn: sqlite3.Connection, run_id: str) -> List[dict]:
    return [
        dict(r)
        for r in conn.execute(
            "SELECT * FROM project_run_cards WHERE run_id = ?", (run_id,)
        ).fetchall()
    ]


def get_run_card_by_task(
    conn: sqlite3.Connection, task_id: str
) -> Optional[dict]:
    """Reverse lookup: the run (if any) a card belongs to.

    Used by ``projects_reconcile`` to find the owning run of a card that
    just settled (done/blocked) on the kanban side, so the run can top up
    its promoted cards without the kanban store knowing anything about
    Projects.
    """
    row = conn.execute(
        "SELECT * FROM project_run_cards WHERE task_id = ?", (task_id,)
    ).fetchone()
    return dict(row) if row else None


# ---------------------------------------------------------------------------
# Root migration: import the legacy per-profile stores (design §2.1)
# ---------------------------------------------------------------------------

# The v1 columns a legacy store can carry. Anything newer (goal, status, …)
# cannot exist in a pre-repoint store, so there is nothing else to copy.
_LEGACY_PROJECT_COLUMNS = (
    "id",
    "slug",
    "name",
    "description",
    "icon",
    "color",
    "board_slug",
    "primary_path",
    "created_at",
    "archived",
)


def _legacy_store_candidates(root: Path, target: Path) -> List[tuple]:
    """(profile_name, db_path) for every per-profile projects.db under root.

    Only the profile layout has legacy stores to import: ``<root>/profiles/
    <name>/projects.db``. When ``HERMES_HOME`` equals the root (Docker /
    custom deployments) the legacy DB *is* the root DB — upgraded in place,
    nothing to import — and it is skipped via the target comparison.
    """
    candidates: List[tuple] = []
    profiles_dir = root / "profiles"
    if not profiles_dir.is_dir():
        return candidates
    target_resolved = target.resolve()
    for entry in sorted(profiles_dir.iterdir()):
        try:
            if not entry.is_dir():
                continue
            db = entry / "projects.db"
            if not db.is_file() or db.resolve() == target_resolved:
                continue
        except OSError:
            continue
        candidates.append((entry.name, db))
    return candidates


def _import_one_profile_store(
    conn: sqlite3.Connection, profile: str, db_path: Path
) -> int:
    """Copy one legacy per-profile store into the root store.

    Idempotent, keyed on ``(imported_from_profile, old id)``. Slug
    collisions get a ``-2``-style suffix; an id already owned by a row from
    elsewhere is remapped to a fresh id (children follow). Returns the
    number of projects imported by this call.
    """
    try:
        src = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    except sqlite3.Error as exc:
        logger.warning("projects: cannot open legacy store %s: %s", db_path, exc)
        return 0
    imported = 0
    try:
        src.row_factory = sqlite3.Row
        tables = {
            r[0]
            for r in src.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
        if "projects" not in tables:
            return 0
        src_cols = {
            r["name"] for r in src.execute("PRAGMA table_info(projects)")
        }
        project_rows = src.execute(
            "SELECT * FROM projects ORDER BY created_at ASC"
        ).fetchall()
        if not project_rows:
            return 0

        id_map: dict = {}
        with write_txn(conn):
            for row in project_rows:
                old_id = row["id"]
                if conn.execute(
                    "SELECT 1 FROM projects "
                    "WHERE imported_from_profile = ? AND id = ?",
                    (profile, old_id),
                ).fetchone() is not None:
                    id_map[old_id] = old_id  # imported on an earlier pass
                    continue
                new_id = old_id
                if conn.execute(
                    "SELECT 1 FROM projects WHERE id = ?", (new_id,)
                ).fetchone() is not None:
                    new_id = _new_project_id()
                    while conn.execute(
                        "SELECT 1 FROM projects WHERE id = ?", (new_id,)
                    ).fetchone() is not None:
                        new_id = _new_project_id()
                slug = _unique_slug(conn, str(row["slug"]).strip() or _slugify(row["name"]))
                # L2: an imported row arrives without a goal, outputs or a
                # host profile — the mandatory-field invariant cannot hold
                # for it, so it lands quarantined in 'needs_completion'
                # until a human completes it (the status gate names what
                # is missing; the doctor surfaces it on the list page).
                conn.execute(
                    "INSERT INTO projects "
                    "(id, slug, name, description, icon, color, board_slug, "
                    " primary_path, status, created_at, archived, "
                    " imported_from_profile) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        new_id,
                        slug,
                        row["name"],
                        row["description"] if "description" in src_cols else None,
                        row["icon"] if "icon" in src_cols else None,
                        row["color"] if "color" in src_cols else None,
                        row["board_slug"] if "board_slug" in src_cols else None,
                        row["primary_path"] if "primary_path" in src_cols else None,
                        "needs_completion",
                        row["created_at"],
                        int(bool(row["archived"])),
                        profile,
                    ),
                )
                id_map[old_id] = new_id
                imported += 1

            if imported and "project_folders" in tables:
                for r in src.execute("SELECT * FROM project_folders"):
                    new_pid = id_map.get(r["project_id"])
                    if new_pid is None:
                        continue
                    conn.execute(
                        "INSERT OR IGNORE INTO project_folders "
                        "(project_id, path, label, is_primary, added_at) "
                        "VALUES (?, ?, ?, ?, ?)",
                        (
                            new_pid,
                            r["path"],
                            r["label"],
                            int(bool(r["is_primary"])),
                            r["added_at"],
                        ),
                    )
            if imported and "project_profiles" in tables:
                for r in src.execute("SELECT * FROM project_profiles"):
                    new_pid = id_map.get(r["project_id"])
                    if new_pid is None:
                        continue
                    conn.execute(
                        "INSERT OR IGNORE INTO project_profiles "
                        "(project_id, profile, role, added_by, added_at) "
                        "VALUES (?, ?, ?, ?, ?)",
                        (new_pid, r["profile"], r["role"], r["added_by"], r["added_at"]),
                    )
            if imported and "project_links" in tables:
                for r in src.execute("SELECT * FROM project_links"):
                    new_pid = id_map.get(r["project_id"])
                    if new_pid is None:
                        continue
                    conn.execute(
                        "INSERT OR IGNORE INTO project_links "
                        "(project_id, kind, profile, ref, label, added_by, added_at) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?)",
                        (
                            new_pid,
                            r["kind"],
                            r["profile"],
                            r["ref"],
                            r["label"],
                            r["added_by"],
                            r["added_at"],
                        ),
                    )
    except sqlite3.Error as exc:
        logger.warning("projects: skipping legacy store %s: %s", db_path, exc)
        return 0
    finally:
        with contextlib.suppress(Exception):
            src.close()
    return imported


def import_profile_stores(conn: sqlite3.Connection, root: Path) -> int:
    """Import every legacy per-profile projects.db under ``root``.

    Called on the first open of the root DB (see :func:`connect`). Row-keyed
    idempotent — a second run is a no-op. The per-profile files are left in
    place, untouched, so pointing ``HERMES_PROJECTS_DB`` back at one
    reverses the migration. Returns the number of projects imported.
    """
    imported = 0
    for profile, db_path in _legacy_store_candidates(Path(root), Path(root) / "projects.db"):
        try:
            n = _import_one_profile_store(conn, profile, db_path)
        except Exception as exc:  # never let one bad store stop the rest
            logger.warning("projects: skipping legacy store %s: %s", db_path, exc)
            continue
        if n:
            logger.info(
                "projects: imported %d project(s) from profile store %s", n, db_path
            )
        imported += n
    return imported


# ---------------------------------------------------------------------------
# Scope clarification (agent asks before implementation)
# ---------------------------------------------------------------------------

CLARIFY_CATEGORIES = (
    "goal", "scope", "audience", "success", "constraints", "inputs", "format", "other",
)
CLARIFY_MAX_QUESTIONS = 7
_CLARIFY_TEXT_MAX = 2_000


def _clarify_question_row(row: sqlite3.Row) -> dict:
    d = dict(row)
    try:
        opts = json.loads(d.get("options") or "[]")
    except (TypeError, ValueError):
        opts = []
    d["options"] = [str(o) for o in opts if str(o).strip()] if isinstance(opts, list) else []
    d["allow_multiple"] = bool(d.get("allow_multiple"))
    return d


def _clarify_round_row(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["done"] = bool(d.get("done"))
    return d


def add_clarify_round(
    conn: sqlite3.Connection,
    project_id: str,
    *,
    questions: List[dict],
    understanding: Optional[str],
    done: bool,
    created_by: str,
    focus: Optional[str] = None,
) -> int:
    """Record one round of agent questions; returns its ``round_no``.

    Each question: ``{question, why?, category?, options?: [str],
    allow_multiple?: bool}``. Blank questions are dropped, at most
    :data:`CLARIFY_MAX_QUESTIONS` are kept, unknown categories become
    ``other``. A round with no questions is recorded as ``answered``."""
    if not str(created_by or "").strip():
        raise ValueError("created_by is required")
    cleaned: List[dict] = []
    for q in questions or []:
        text = str((q or {}).get("question") or "").strip()[:_CLARIFY_TEXT_MAX]
        if not text:
            continue
        cat = str(q.get("category") or "other").strip().lower()
        opts = q.get("options") or []
        if not isinstance(opts, list):
            opts = []
        cleaned.append({
            "question": text,
            "why": (str(q.get("why") or "").strip()[:_CLARIFY_TEXT_MAX] or None),
            "category": cat if cat in CLARIFY_CATEGORIES else "other",
            "options": [str(o).strip()[:200] for o in opts if str(o).strip()][:6],
            "allow_multiple": bool(q.get("allow_multiple")),
        })
        if len(cleaned) >= CLARIFY_MAX_QUESTIONS:
            break
    now = _now()
    with write_txn(conn):
        row = conn.execute(
            "SELECT COALESCE(MAX(round_no), 0) AS n FROM project_clarify_rounds "
            "WHERE project_id = ?",
            (project_id,),
        ).fetchone()
        round_no = int(row["n"]) + 1
        conn.execute(
            """INSERT INTO project_clarify_rounds
               (project_id, round_no, status, understanding, done, focus,
                created_by, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (project_id, round_no, "open" if cleaned else "answered",
             (str(understanding).strip() or None) if understanding else None,
             1 if done else 0, (str(focus).strip() or None) if focus else None,
             str(created_by).strip(), now),
        )
        for pos, q in enumerate(cleaned):
            conn.execute(
                """INSERT INTO project_clarifications
                   (id, project_id, round_no, position, category, question, why,
                    options, allow_multiple, status, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)""",
                (_new_row_id("clq"), project_id, round_no, pos, q["category"],
                 q["question"], q["why"], json.dumps(q["options"], ensure_ascii=False),
                 1 if q["allow_multiple"] else 0, now),
            )
    return round_no


def list_clarify_rounds(conn: sqlite3.Connection, project_id: str) -> List[dict]:
    """Every round, oldest first."""
    rows = conn.execute(
        "SELECT * FROM project_clarify_rounds WHERE project_id = ? ORDER BY round_no",
        (project_id,),
    ).fetchall()
    return [_clarify_round_row(r) for r in rows]


def list_clarifications(
    conn: sqlite3.Connection,
    project_id: str,
    *,
    round_no: Optional[int] = None,
) -> List[dict]:
    """Questions (with ``options`` decoded), oldest round first, in order."""
    sql = "SELECT * FROM project_clarifications WHERE project_id = ?"
    args: list[Any] = [project_id]
    if round_no is not None:
        sql += " AND round_no = ?"
        args.append(int(round_no))
    sql += " ORDER BY round_no, position"
    return [_clarify_question_row(r) for r in conn.execute(sql, args).fetchall()]


def answer_clarifications(
    conn: sqlite3.Connection,
    project_id: str,
    answers: List[dict],
    *,
    user_id: str,
) -> int:
    """Apply ``[{id, answer?: str, skip?: bool}]``; returns rows changed.

    An answer may be changed until its round is confirmed; a confirmed
    round's questions are refused with ``ValueError``. Unknown ids raise
    ``KeyError``. A round whose questions are all answered/skipped moves to
    ``answered``."""
    if not str(user_id or "").strip():
        raise ValueError("user_id is required")
    now = _now()
    changed = 0
    touched_rounds: set[int] = set()
    with write_txn(conn):
        for item in answers or []:
            qid = str((item or {}).get("id") or "")
            row = conn.execute(
                "SELECT q.round_no, r.status AS round_status FROM project_clarifications q "
                "JOIN project_clarify_rounds r ON r.project_id = q.project_id "
                "AND r.round_no = q.round_no WHERE q.id = ? AND q.project_id = ?",
                (qid, project_id),
            ).fetchone()
            if row is None:
                raise KeyError(qid)
            if row["round_status"] == "confirmed":
                raise ValueError("that round is already confirmed")
            if item.get("skip"):
                status, answer = "skipped", None
            else:
                answer = str(item.get("answer") or "").strip()[:_CLARIFY_TEXT_MAX]
                if not answer:
                    raise ValueError("an answer must not be empty (or skip it)")
                status = "answered"
            conn.execute(
                "UPDATE project_clarifications SET status = ?, answer = ?, "
                "answered_by = ?, answered_at = ? WHERE id = ?",
                (status, answer, str(user_id).strip(), now, qid),
            )
            changed += 1
            touched_rounds.add(int(row["round_no"]))
        for rn in touched_rounds:
            open_n = conn.execute(
                "SELECT COUNT(*) AS n FROM project_clarifications "
                "WHERE project_id = ? AND round_no = ? AND status = 'open'",
                (project_id, rn),
            ).fetchone()["n"]
            conn.execute(
                "UPDATE project_clarify_rounds SET status = ? "
                "WHERE project_id = ? AND round_no = ? AND status != 'confirmed'",
                ("open" if open_n else "answered", project_id, rn),
            )
    return changed


def confirm_clarify_round(
    conn: sqlite3.Connection,
    project_id: str,
    *,
    user_id: str,
    understanding: Optional[str] = None,
) -> Optional[dict]:
    """Confirm the latest round (open questions become ``skipped``), storing
    an edited ``understanding`` when given. Returns the round, or ``None``
    when the project has no rounds."""
    if not str(user_id or "").strip():
        raise ValueError("user_id is required")
    now = _now()
    with write_txn(conn):
        row = conn.execute(
            "SELECT * FROM project_clarify_rounds WHERE project_id = ? "
            "ORDER BY round_no DESC LIMIT 1",
            (project_id,),
        ).fetchone()
        if row is None:
            return None
        rn = int(row["round_no"])
        conn.execute(
            "UPDATE project_clarifications SET status = 'skipped', answered_by = ?, "
            "answered_at = ? WHERE project_id = ? AND round_no = ? AND status = 'open'",
            (str(user_id).strip(), now, project_id, rn),
        )
        text = (str(understanding).strip()[:_CLARIFY_TEXT_MAX * 2] if understanding else "")
        conn.execute(
            "UPDATE project_clarify_rounds SET status = 'confirmed', confirmed_by = ?, "
            "confirmed_at = ?, understanding = COALESCE(?, understanding) "
            "WHERE project_id = ? AND round_no = ?",
            (str(user_id).strip(), now, text or None, project_id, rn),
        )
        out = conn.execute(
            "SELECT * FROM project_clarify_rounds WHERE project_id = ? AND round_no = ?",
            (project_id, rn),
        ).fetchone()
    return _clarify_round_row(out)


def clarify_summary(conn: sqlite3.Connection, project_id: str) -> dict:
    """The compact state the project detail read carries as ``clarify``.

    ``status``: ``not_started`` (no round) | ``open`` (latest round has open
    questions) | ``answered`` (all answered/skipped, not confirmed) |
    ``confirmed``. ``understanding`` is the latest confirmed one."""
    rounds = list_clarify_rounds(conn, project_id)
    if not rounds:
        return {"status": "not_started", "round": 0, "open_count": 0,
                "answered_count": 0, "understanding": None, "confirmed_at": None}
    latest = rounds[-1]
    counts = {r["status"]: r["n"] for r in conn.execute(
        "SELECT status, COUNT(*) AS n FROM project_clarifications "
        "WHERE project_id = ? AND round_no = ? GROUP BY status",
        (project_id, latest["round_no"]),
    ).fetchall()}
    confirmed = [r for r in rounds if r["status"] == "confirmed"]
    return {
        "status": latest["status"],
        "round": latest["round_no"],
        "open_count": int(counts.get("open", 0)),
        "answered_count": int(counts.get("answered", 0)),
        "understanding": confirmed[-1]["understanding"] if confirmed else None,
        "confirmed_at": confirmed[-1]["confirmed_at"] if confirmed else None,
    }
