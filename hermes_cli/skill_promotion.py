"""Moving one distilled skill across the profile boundary. Nothing else.

Hermes already learns: ``background_review`` distils a session into a skill and
the curator keeps the collection tidy. What it cannot do is let a profile
benefit from what another profile learned, because profiles are isolated
schemas and directories by design. That single missing step — *promotion* — is
all this module implements. There is deliberately no new "insights" pipeline
here; the candidate is an ordinary skill that already exists on disk.

Four properties, each of which is a decision the owner already made:

* **Scored, not shouted.** A candidate is quantified from evidence that already
  exists (usage telemetry, and the measured progress of the goal it was
  proposed against). Below the threshold it is stored and never surfaced. The
  review is a weekly digest, because a promotion is never urgent and an
  interrupt would be paid for by whoever is mid-task.
* **Capped, therefore competitive.** Shared skills are listed in the stable
  prompt of *every* profile, so an unbounded shared library taxes every turn
  everywhere. At the cap a newcomer is promoted only by displacing a strictly
  weaker resident, and a resident nobody uses becomes a demotion candidate.
* **Two stages, one code path.** The origin profile's reviewer approves first —
  only they can tell whether a skill carries traces of the people who taught
  it — and the owner approves second, because only they can say it belongs to
  the whole entity. There is no auto-approval branch, not even for a
  single-principal install: a minute a week is cheaper than a second code path
  that can approve on its own.
* **Exact reviewed bytes.** The proposal records a hash of the body that was
  reviewed. Approval re-reads the file and refuses on mismatch, so "approved"
  always means the text somebody actually read.

The shared tier stays unreachable to autonomous curation: it lives under
``skills.external_dirs``, which
:func:`agent.skill_utils.is_external_skill_path` already makes read-only to the
curator. This module writes it, the curator cannot, and that asymmetry *is* the
audited path.
"""

from __future__ import annotations

import hashlib
import logging
import shutil
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import TYPE_CHECKING, List, Optional, Sequence, Tuple

from hermes_cli.access import normalize_visibility
from hermes_constants import get_default_hermes_root, get_skills_dir

if TYPE_CHECKING:  # pragma: no cover - typing only
    import asyncpg

    from hermes_cli.access import Principal
    from hermes_cli.datastore import SupabaseAppStore

log = logging.getLogger(__name__)

PROMOTIONS_TABLE = "skill_promotions"
PROMOTION_AUDIT_TABLE = "skill_promotion_audit"
SHARED_SKILLS_TABLE = "shared_skills"

#: The proposal lifecycle. ``profile_approved`` is a real state rather than a
#: boolean pair because the whole point is that the two approvals are ordered
#: and separately attributable.
PROMOTION_STATES: Tuple[str, ...] = (
    "proposed",
    "profile_approved",
    "approved",
    "rejected",
    "demoted",
)

#: States in which a proposal is still awaiting somebody.
OPEN_STATES: Tuple[str, ...] = ("proposed", "profile_approved")

#: Roles that may perform the *origin-profile* review. ``admin`` is the profile
#: reviewer: the teacher who runs the profile. The owner may also do it (a lone
#: founder is both), but an admin explicitly may NOT do the second stage.
PROFILE_REVIEWER_ROLES: Tuple[str, ...] = ("owner", "admin")

#: Defaults, all **uncalibrated guesses** — see ``goals.promotion`` in
#: ``config.yaml``. A ~30-user pilot is expected to retune them; nothing in the
#: code depends on the particular numbers.
DEFAULT_THRESHOLD = 0.55
DEFAULT_MAX_SHARED_SKILLS = 24
DEFAULT_DEMOTE_UNUSED_AFTER = timedelta(days=90)
DEFAULT_USAGE_TARGET = 10

#: Weights of the three score components. Usage dominates because it is the
#: only signal measured without judgement; goal outcome is the signal that
#: matters most but is the noisiest; durability is a tie-breaker that stops a
#: skill written yesterday from displacing one that has worked for months.
_WEIGHT_USAGE = 0.5
_WEIGHT_OUTCOME = 0.3
_WEIGHT_DURABILITY = 0.2
_DURABILITY_SATURATES = timedelta(days=30)

SCHEMA_SQL = f"""
CREATE TABLE IF NOT EXISTS {PROMOTIONS_TABLE} (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    skill_name TEXT NOT NULL,
    origin_profile TEXT NOT NULL,
    proposed_by TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'shared',
    rationale TEXT NOT NULL DEFAULT '',
    goal_id UUID NULL REFERENCES goals(id) ON DELETE SET NULL,
    score DOUBLE PRECISION NOT NULL DEFAULT 0,
    body_sha256 TEXT NOT NULL,
    body_bytes INTEGER NOT NULL DEFAULT 0,
    -- Set when the skill was distilled from sessions that included another
    -- person's private material. Approval is refused until consent is on the
    -- row: the teacher's students never agreed to be a shared skill.
    derived_from_private BOOLEAN NOT NULL DEFAULT FALSE,
    consent_user_ids TEXT[] NOT NULL DEFAULT '{{}}',
    consent_recorded_at TIMESTAMPTZ NULL,
    state TEXT NOT NULL DEFAULT 'proposed',
    profile_reviewer TEXT NULL,
    profile_reviewed_at TIMESTAMPTZ NULL,
    owner_reviewer TEXT NULL,
    owner_reviewed_at TIMESTAMPTZ NULL,
    decision_note TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE {PROMOTIONS_TABLE}
    DROP CONSTRAINT IF EXISTS {PROMOTIONS_TABLE}_state_check;
ALTER TABLE {PROMOTIONS_TABLE}
    ADD CONSTRAINT {PROMOTIONS_TABLE}_state_check
    CHECK (state IN ({", ".join(f"'{state}'" for state in PROMOTION_STATES)}));
-- One open proposal per skill: re-proposing a skill that is already waiting
-- for a reviewer would put the same decision in the digest twice.
CREATE UNIQUE INDEX IF NOT EXISTS {PROMOTIONS_TABLE}_one_open
    ON {PROMOTIONS_TABLE} (skill_name)
    WHERE state IN ({", ".join(f"'{state}'" for state in OPEN_STATES)});
CREATE INDEX IF NOT EXISTS {PROMOTIONS_TABLE}_state_idx
    ON {PROMOTIONS_TABLE} (state, score DESC);

-- Append-only. Every state change of every proposal, with who and what they
-- were looking at. A rejected proposal keeps its rows: "we considered this and
-- said no" is the answer to the same skill being proposed again next month.
CREATE TABLE IF NOT EXISTS {PROMOTION_AUDIT_TABLE} (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    promotion_id UUID NOT NULL REFERENCES {PROMOTIONS_TABLE}(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    actor_user_id TEXT NOT NULL,
    actor_role TEXT NOT NULL,
    body_sha256 TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT '',
    at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS {PROMOTION_AUDIT_TABLE}_promotion_idx
    ON {PROMOTION_AUDIT_TABLE} (promotion_id, at);

-- The residents of the shared library, and what each one scored when it got
-- in. This is what makes the cap competitive rather than first-come.
CREATE TABLE IF NOT EXISTS {SHARED_SKILLS_TABLE} (
    skill_name TEXT PRIMARY KEY,
    origin_profile TEXT NOT NULL,
    promotion_id UUID NULL,
    score DOUBLE PRECISION NOT NULL DEFAULT 0,
    body_sha256 TEXT NOT NULL DEFAULT '',
    promoted_by TEXT NOT NULL DEFAULT '',
    promoted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_scored_at TIMESTAMPTZ NULL,
    demoted_at TIMESTAMPTZ NULL,
    demote_reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS {SHARED_SKILLS_TABLE}_live_idx
    ON {SHARED_SKILLS_TABLE} (demoted_at, score);
"""

_PROMOTION_COLUMNS = (
    "id, skill_name, origin_profile, proposed_by, visibility, rationale, "
    "goal_id, score, body_sha256, body_bytes, derived_from_private, "
    "consent_user_ids, consent_recorded_at, state, profile_reviewer, "
    "profile_reviewed_at, owner_reviewer, owner_reviewed_at, decision_note, "
    "created_at, updated_at"
)


class PromotionError(RuntimeError):
    """A refused promotion operation."""


class PromotionConsentError(PromotionError):
    """The candidate was distilled from private material without consent."""


class PromotionBodyChangedError(PromotionError):
    """The skill body changed since it was reviewed."""


@dataclass(frozen=True)
class PromotionCandidate:
    """A proposal, as stored."""

    id: str
    skill_name: str
    origin_profile: str
    proposed_by: str
    visibility: str
    rationale: str
    goal_id: Optional[str]
    score: float
    body_sha256: str
    body_bytes: int
    derived_from_private: bool
    consent_user_ids: Tuple[str, ...]
    consent_recorded_at: Optional[datetime]
    state: str
    profile_reviewer: Optional[str]
    profile_reviewed_at: Optional[datetime]
    owner_reviewer: Optional[str]
    owner_reviewed_at: Optional[datetime]
    decision_note: str
    created_at: Optional[datetime]
    updated_at: Optional[datetime]

    @property
    def has_consent(self) -> bool:
        """Whether a private-derived candidate may proceed at all."""
        if not self.derived_from_private:
            return True
        return bool(self.consent_user_ids) and self.consent_recorded_at is not None

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "skill_name": self.skill_name,
            "origin_profile": self.origin_profile,
            "proposed_by": self.proposed_by,
            "rationale": self.rationale,
            "goal_id": self.goal_id,
            "score": self.score,
            "state": self.state,
            "derived_from_private": self.derived_from_private,
            "has_consent": self.has_consent,
            "profile_reviewer": self.profile_reviewer,
            "owner_reviewer": self.owner_reviewer,
            "decision_note": self.decision_note,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }


@dataclass(frozen=True)
class SharedSkill:
    """One resident of the shared library."""

    skill_name: str
    origin_profile: str
    score: float
    body_sha256: str
    promoted_by: str
    promoted_at: Optional[datetime]
    demoted_at: Optional[datetime] = None
    demote_reason: str = ""

    @property
    def live(self) -> bool:
        return self.demoted_at is None


@dataclass(frozen=True)
class PromotionSettings:
    """The tunables, resolved once from ``config.yaml``."""

    threshold: float = DEFAULT_THRESHOLD
    max_shared_skills: int = DEFAULT_MAX_SHARED_SKILLS
    demote_unused_after: timedelta = DEFAULT_DEMOTE_UNUSED_AFTER
    usage_target: int = DEFAULT_USAGE_TARGET

    @classmethod
    def from_config(cls, config: Optional[dict] = None) -> "PromotionSettings":
        resolved = config
        if resolved is None:
            from hermes_cli.config import load_config_readonly

            resolved = load_config_readonly() or {}
        goals_cfg = resolved.get("goals")
        raw = goals_cfg.get("promotion") if isinstance(goals_cfg, dict) else None
        if not isinstance(raw, dict):
            return cls()
        threshold = raw.get("threshold")
        cap = raw.get("max_shared_skills")
        unused_days = raw.get("demote_unused_after_days")
        usage_target = raw.get("usage_target")
        return cls(
            threshold=(
                float(threshold)
                if isinstance(threshold, (int, float)) and 0 <= float(threshold) <= 1
                else DEFAULT_THRESHOLD
            ),
            max_shared_skills=(
                int(cap)
                if isinstance(cap, int) and cap > 0
                else DEFAULT_MAX_SHARED_SKILLS
            ),
            demote_unused_after=(
                timedelta(days=int(unused_days))
                if isinstance(unused_days, int) and unused_days > 0
                else DEFAULT_DEMOTE_UNUSED_AFTER
            ),
            usage_target=(
                int(usage_target)
                if isinstance(usage_target, int) and usage_target > 0
                else DEFAULT_USAGE_TARGET
            ),
        )


# ---------------------------------------------------------------------------
# The shared library on disk
# ---------------------------------------------------------------------------


def shared_skills_dir() -> Path:
    """Where promoted skills live: one directory beside the profiles.

    Deliberately at the Hermes *root*, not inside a profile: it is the entity's
    library, and a per-profile copy would make "which one is authoritative"
    a question. Every profile reads it through ``skills.external_dirs``, which
    is also what makes it read-only to autonomous curation.
    """
    return get_default_hermes_root() / "skills-shared"


def register_shared_dir() -> bool:
    """Ensure ``skills.external_dirs`` contains the shared library.

    Returns whether the config had to be changed. Idempotent, and only ever
    *adds* — a user who removed the entry deliberately gets it back on the next
    promotion, which is the honest behaviour: the skills are there either way,
    and silently not reading them would be worse.
    """
    from hermes_cli.config import load_config, save_config

    target = str(shared_skills_dir())
    config = load_config() or {}
    skills = config.get("skills")
    if not isinstance(skills, dict):
        skills = {}
        config["skills"] = skills
    dirs = skills.get("external_dirs")
    if not isinstance(dirs, list):
        dirs = []
    if any(str(entry) == target for entry in dirs):
        return False
    skills["external_dirs"] = [*dirs, target]
    save_config(config, preserve_keys={("skills", "external_dirs")})
    from agent.skill_utils import _external_dirs_cache_clear, _raw_config_cache_clear

    _raw_config_cache_clear()
    _external_dirs_cache_clear()
    return True


def _iter_skill_files(root: Path):
    if not root.exists():
        return
    from agent.skill_utils import is_excluded_skill_path

    for path in sorted(root.rglob("SKILL.md")):
        if not is_excluded_skill_path(path):
            yield path


def find_local_skill(skill_name: str) -> Optional[Path]:
    """The ``SKILL.md`` for ``skill_name`` in *this* profile, if any.

    Matches the frontmatter ``name`` first and the directory name second,
    mirroring how the skills index resolves a name.
    """
    from agent.skill_utils import parse_frontmatter

    fallback: Optional[Path] = None
    for path in _iter_skill_files(get_skills_dir()):
        if path.parent.name == skill_name:
            fallback = path
        try:
            frontmatter, _ = parse_frontmatter(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        name = frontmatter.get("name")
        if isinstance(name, str) and name.strip() == skill_name:
            return path
    return fallback


def contained_shared_path(skill_name: str) -> Path:
    """Where ``skill_name`` may live in the shared library, or refuse.

    A skill's name comes from its own frontmatter (or its directory), and the
    self-improvement loop writes both without a human in the loop — so a name
    is untrusted input on a path that copies directories and deletes what it
    replaces. Anything that does not resolve to a single child of the shared
    library is refused rather than normalised: a promotion is a deliberate act,
    and a name that needs normalising is not the name anybody reviewed.
    """
    name = (skill_name or "").strip()
    shared = shared_skills_dir()
    candidate = shared / name
    resolved = candidate.resolve()
    if not name or resolved.parent != shared.resolve() or resolved == shared.resolve():
        raise PromotionError(
            f"Refusing to promote a skill named {skill_name!r}: it does not "
            f"name a single directory inside {shared}"
        )
    return candidate


def body_hash(body: str) -> str:
    """The hash recorded at review time and re-checked at approval time."""
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------


def score_candidate(
    *,
    activity: int,
    goal_progress: Optional[float],
    age: Optional[timedelta],
    settings: Optional[PromotionSettings] = None,
) -> float:
    """Quantify a candidate in ``[0, 1]`` from evidence that already exists.

    Three components, because each answers a different objection:

    * **usage** — has anyone actually used it? Saturates at
      ``settings.usage_target`` uses/views/patches.
    * **outcome** — did the goal it was proposed against move? This is the
      component the shared measure exists for. A candidate proposed against no
      goal, or against an unmeasured one, scores **zero here rather than being
      excused**: promotion is a claim that something helped the entity, and an
      unevidenced claim should lose to an evidenced one.
    * **durability** — has it survived a while? Saturates at 30 days.

    The weights and the saturation points are guesses. What is not a guess is
    the shape: a skill can only clear a mid-range threshold by scoring on more
    than one axis.
    """
    resolved = settings or PromotionSettings()
    usage = min(1.0, max(0, activity) / max(1, resolved.usage_target))
    outcome = 0.0
    if goal_progress is not None:
        outcome = min(1.0, max(0.0, goal_progress))
    durability = 0.0
    if age is not None and age.total_seconds() > 0:
        durability = min(
            1.0, age.total_seconds() / _DURABILITY_SATURATES.total_seconds()
        )
    return round(
        _WEIGHT_USAGE * usage
        + _WEIGHT_OUTCOME * outcome
        + _WEIGHT_DURABILITY * durability,
        4,
    )


def local_activity(skill_name: str) -> Tuple[int, Optional[timedelta], Optional[datetime]]:
    """``(activity, age, last_used_at)`` from the existing usage telemetry.

    Reads ``tools.skill_usage`` rather than counting anything new: the
    self-improvement loop already records every use, view and patch, and a
    second counter would eventually disagree with the first.
    """
    from tools.skill_usage import activity_count, get_record

    record = get_record(skill_name)
    activity = activity_count(record)
    age: Optional[timedelta] = None
    created = _parse_iso(record.get("created_at"))
    if created is not None:
        age = datetime.now(timezone.utc) - created
    return activity, age, _parse_iso(record.get("last_used_at"))


def _parse_iso(value: object) -> Optional[datetime]:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


def _row_to_candidate(row) -> PromotionCandidate:
    consent = row["consent_user_ids"] or []
    return PromotionCandidate(
        id=str(row["id"]),
        skill_name=str(row["skill_name"]),
        origin_profile=str(row["origin_profile"]),
        proposed_by=str(row["proposed_by"]),
        visibility=str(row["visibility"]),
        rationale=str(row["rationale"]),
        goal_id=str(row["goal_id"]) if row["goal_id"] is not None else None,
        score=float(row["score"]),
        body_sha256=str(row["body_sha256"]),
        body_bytes=int(row["body_bytes"]),
        derived_from_private=bool(row["derived_from_private"]),
        consent_user_ids=tuple(str(item) for item in consent),
        consent_recorded_at=row["consent_recorded_at"],
        state=str(row["state"]),
        profile_reviewer=(
            str(row["profile_reviewer"]) if row["profile_reviewer"] else None
        ),
        profile_reviewed_at=row["profile_reviewed_at"],
        owner_reviewer=str(row["owner_reviewer"]) if row["owner_reviewer"] else None,
        owner_reviewed_at=row["owner_reviewed_at"],
        decision_note=str(row["decision_note"]),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _row_to_shared(row) -> SharedSkill:
    return SharedSkill(
        skill_name=str(row["skill_name"]),
        origin_profile=str(row["origin_profile"]),
        score=float(row["score"]),
        body_sha256=str(row["body_sha256"]),
        promoted_by=str(row["promoted_by"]),
        promoted_at=row["promoted_at"],
        demoted_at=row["demoted_at"],
        demote_reason=str(row["demote_reason"]),
    )


class SkillPromotionStore:
    """The promotion queue, the shared library and the audit trail.

    Routed through the same profile-derived :class:`SupabaseAppStore` as every
    other C3 consumer, so the queue for a profile lives in that profile's
    schema — a proposal is *about* that profile's skill, and its first reviewer
    is that profile's reviewer.
    """

    def __init__(
        self,
        store: "SupabaseAppStore",
        *,
        settings: Optional[PromotionSettings] = None,
    ) -> None:
        from hermes_cli.datastore import SupabaseAppStore

        if not isinstance(store, SupabaseAppStore):
            raise TypeError("SkillPromotionStore requires a supabase-app store")
        self._store = store
        self._settings = settings or PromotionSettings.from_config()

    @property
    def settings(self) -> PromotionSettings:
        return self._settings

    async def _connect(self) -> "asyncpg.Connection":
        conn = await self._store.connect()
        await conn.execute(f'CREATE SCHEMA IF NOT EXISTS "{self._store.schema}"')
        return conn

    async def initialize(
        self, *, connection: Optional["asyncpg.Connection"] = None
    ) -> None:
        """Create the promotion tables (idempotent)."""
        own = connection is None
        conn = connection or await self._connect()
        try:
            await conn.execute(SCHEMA_SQL)
        finally:
            if own:
                await conn.close()

    # -- proposing ----------------------------------------------------------

    async def propose(
        self,
        principal: "Principal",
        skill_name: str,
        *,
        rationale: str = "",
        goal_id: Optional[str] = None,
        goal_progress: Optional[float] = None,
        derived_from_private: bool = False,
        consent_user_ids: Sequence[str] = (),
        origin_profile: Optional[str] = None,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> PromotionCandidate:
        """Record a scored proposal for ``skill_name``.

        Scoring happens here, once, against the evidence at proposal time —
        not in the digest. A candidate whose score depended on when the digest
        happened to run would be unreviewable.
        """
        path = find_local_skill(skill_name)
        if path is None:
            raise PromotionError(
                f"No skill named {skill_name!r} in this profile; only a skill "
                f"that exists here can be promoted from here"
            )
        from agent.skill_utils import is_external_skill_path

        if is_external_skill_path(path):
            raise PromotionError(
                f"Skill {skill_name!r} already lives in an external/shared "
                f"directory; there is nothing to promote"
            )
        contained_shared_path(skill_name)
        body = path.read_text(encoding="utf-8")
        activity, age, _ = local_activity(skill_name)
        score = score_candidate(
            activity=activity,
            goal_progress=goal_progress,
            age=age,
            settings=self._settings,
        )
        profile = origin_profile or _active_profile()
        own = connection is None
        conn = connection or await self._connect()
        try:
            await self.initialize(connection=conn)
            existing = await conn.fetchrow(
                f"""
                SELECT {_PROMOTION_COLUMNS} FROM {PROMOTIONS_TABLE}
                WHERE skill_name = $1 AND state = ANY($2::text[])
                """,
                skill_name,
                list(OPEN_STATES),
            )
            if existing is not None:
                return _row_to_candidate(existing)
            row = await conn.fetchrow(
                f"""
                INSERT INTO {PROMOTIONS_TABLE}
                    (skill_name, origin_profile, proposed_by, visibility,
                     rationale, goal_id, score, body_sha256, body_bytes,
                     derived_from_private, consent_user_ids,
                     consent_recorded_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text[],
                        CASE WHEN $11::text[] = '{{}}'::text[]
                             THEN NULL ELSE NOW() END)
                RETURNING {_PROMOTION_COLUMNS}
                """,
                skill_name,
                profile,
                principal.user_id,
                normalize_visibility("shared"),
                rationale,
                goal_id,
                score,
                body_hash(body),
                len(body.encode("utf-8")),
                derived_from_private,
                [str(item) for item in consent_user_ids],
            )
            candidate = _row_to_candidate(row)
            await self._audit(
                conn,
                candidate.id,
                action="proposed",
                principal=principal,
                body_sha256=candidate.body_sha256,
                detail=(
                    f"score={candidate.score} activity={activity} "
                    f"goal={goal_id or '-'}"
                ),
            )
            return candidate
        finally:
            if own:
                await conn.close()

    async def _audit(
        self,
        conn: "asyncpg.Connection",
        promotion_id: str,
        *,
        action: str,
        principal: "Principal",
        body_sha256: str = "",
        detail: str = "",
    ) -> None:
        await conn.execute(
            f"""
            INSERT INTO {PROMOTION_AUDIT_TABLE}
                (promotion_id, action, actor_user_id, actor_role, body_sha256,
                 detail)
            VALUES ($1, $2, $3, $4, $5, $6)
            """,
            promotion_id,
            action,
            principal.user_id,
            principal.role,
            body_sha256,
            detail,
        )

    async def audit_trail(
        self,
        promotion_id: str,
        *,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> List[dict]:
        """Every recorded action for one proposal, oldest first."""
        own = connection is None
        conn = connection or await self._connect()
        try:
            rows = await conn.fetch(
                f"""
                SELECT action, actor_user_id, actor_role, body_sha256, detail, at
                FROM {PROMOTION_AUDIT_TABLE}
                WHERE promotion_id = $1
                ORDER BY at, action
                """,
                promotion_id,
            )
            return [dict(row) for row in rows]
        finally:
            if own:
                await conn.close()

    # -- reading ------------------------------------------------------------

    async def get(
        self,
        principal: "Principal",
        promotion_id: str,
        *,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> Optional[PromotionCandidate]:
        """One proposal by id.

        Every proposal row is ``shared``: a promotion is a decision about the
        entity's library, and hiding one from a reviewer would defeat the
        review. ``principal`` is still required so no caller can read the queue
        without having resolved an identity first.
        """
        own = connection is None
        conn = connection or await self._connect()
        try:
            await self.initialize(connection=conn)
            row = await conn.fetchrow(
                f"SELECT {_PROMOTION_COLUMNS} FROM {PROMOTIONS_TABLE} WHERE id = $1",
                promotion_id,
            )
            return _row_to_candidate(row) if row is not None else None
        finally:
            if own:
                await conn.close()

    async def list_candidates(
        self,
        principal: "Principal",
        *,
        states: Sequence[str] = OPEN_STATES,
        min_score: Optional[float] = None,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> List[PromotionCandidate]:
        """Proposals in ``states``, strongest first (see :meth:`get` on scope).


        ``min_score`` is what keeps a weak candidate out of the digest without
        losing it: the row stays, and a later re-proposal can be compared
        against the score it had.
        """
        own = connection is None
        conn = connection or await self._connect()
        try:
            rows = await conn.fetch(
                f"""
                SELECT {_PROMOTION_COLUMNS} FROM {PROMOTIONS_TABLE}
                WHERE state = ANY($1::text[])
                  AND ($2::float8 IS NULL OR score >= $2::float8)
                ORDER BY score DESC, created_at
                """,
                list(states),
                min_score,
            )
            return [_row_to_candidate(row) for row in rows]
        finally:
            if own:
                await conn.close()

    async def digest_candidates(
        self,
        principal: "Principal",
        *,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> List[PromotionCandidate]:
        """What this week's digest should show: open, and above threshold."""
        return await self.list_candidates(
            principal,
            states=OPEN_STATES,
            min_score=self._settings.threshold,
            connection=connection,
        )

    async def shared_skills(
        self,
        *,
        include_demoted: bool = False,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> List[SharedSkill]:
        own = connection is None
        conn = connection or await self._connect()
        try:
            await self.initialize(connection=conn)
            rows = await conn.fetch(
                f"""
                SELECT * FROM {SHARED_SKILLS_TABLE}
                WHERE ($1::boolean OR demoted_at IS NULL)
                ORDER BY score DESC, skill_name
                """,
                include_demoted,
            )
            return [_row_to_shared(row) for row in rows]
        finally:
            if own:
                await conn.close()

    # -- the two stages -----------------------------------------------------

    async def approve_in_profile(
        self,
        principal: "Principal",
        promotion_id: str,
        *,
        note: str = "",
        connection: Optional["asyncpg.Connection"] = None,
    ) -> PromotionCandidate:
        """Stage one: the origin profile's reviewer signs off.

        Only they can answer the question this stage exists for — whether the
        skill carries traces of the people who taught it. Consent is enforced
        here rather than at the owner's desk, because the owner has no way to
        know whose material it was.
        """
        if principal.role not in PROFILE_REVIEWER_ROLES:
            raise PermissionError(
                f"Role {principal.role!r} may not review promotions for this "
                f"profile; an admin or the owner must"
            )
        own = connection is None
        conn = connection or await self._connect()
        try:
            candidate = await self._require(conn, promotion_id)
            if candidate.state != "proposed":
                raise PromotionError(
                    f"Proposal {promotion_id} is {candidate.state}, not awaiting "
                    f"profile review"
                )
            if not candidate.has_consent:
                await self._audit(
                    conn,
                    promotion_id,
                    action="consent_refused",
                    principal=principal,
                    detail="private-derived skill without recorded consent",
                )
                raise PromotionConsentError(
                    f"Skill {candidate.skill_name!r} was distilled from private "
                    f"material; record consent from every affected participant "
                    f"before it can leave this profile"
                )
            row = await conn.fetchrow(
                f"""
                UPDATE {PROMOTIONS_TABLE}
                SET state = 'profile_approved', profile_reviewer = $2,
                    profile_reviewed_at = NOW(), decision_note = $3,
                    updated_at = NOW()
                WHERE id = $1 AND state = 'proposed'
                RETURNING {_PROMOTION_COLUMNS}
                """,
                promotion_id,
                principal.user_id,
                note,
            )
            if row is None:  # pragma: no cover - lost race
                raise PromotionError(f"Proposal {promotion_id} changed underneath")
            await self._audit(
                conn,
                promotion_id,
                action="profile_approved",
                principal=principal,
                body_sha256=candidate.body_sha256,
                detail=note,
            )
            return _row_to_candidate(row)
        finally:
            if own:
                await conn.close()

    async def approve_for_entity(
        self,
        principal: "Principal",
        promotion_id: str,
        *,
        note: str = "",
        connection: Optional["asyncpg.Connection"] = None,
    ) -> Tuple[PromotionCandidate, Optional[SharedSkill]]:
        """Stage two: the owner accepts it on behalf of the entity.

        Refuses unless stage one already happened, and refuses if the body
        changed since it was reviewed. On success the reviewed bytes are copied
        into the shared library — never the current file, and never a
        rewrite — and the cap is enforced competitively.

        Returns the updated candidate and the resident it displaced, if any.
        The new skill is visible to **new** sessions only: a running session's
        skills block is part of its cached prefix.
        """
        if not principal.is_owner:
            raise PermissionError(
                "Only the owner may accept a skill into the shared library: it "
                "enters the stable prompt of every profile"
            )
        own = connection is None
        conn = connection or await self._connect()
        try:
            candidate = await self._require(conn, promotion_id)
            if candidate.state != "profile_approved":
                raise PromotionError(
                    f"Proposal {promotion_id} is {candidate.state}; the origin "
                    f"profile's reviewer must approve it first"
                )
            if not candidate.has_consent:  # pragma: no cover - stage 1 covers it
                raise PromotionConsentError(
                    f"Skill {candidate.skill_name!r} has no recorded consent"
                )
            path = find_local_skill(candidate.skill_name)
            if path is None:
                raise PromotionError(
                    f"Skill {candidate.skill_name!r} no longer exists in "
                    f"{candidate.origin_profile}"
                )
            body = path.read_text(encoding="utf-8")
            if body_hash(body) != candidate.body_sha256:
                await self._audit(
                    conn,
                    promotion_id,
                    action="body_changed",
                    principal=principal,
                    body_sha256=body_hash(body),
                    detail=f"reviewed {candidate.body_sha256}",
                )
                raise PromotionBodyChangedError(
                    f"Skill {candidate.skill_name!r} changed since it was "
                    f"reviewed; re-propose it so somebody reviews what will "
                    f"actually be shared"
                )
            displaced = await self._make_room(conn, principal, candidate)
            self._install(path, candidate.skill_name)
            row = await conn.fetchrow(
                f"""
                UPDATE {PROMOTIONS_TABLE}
                SET state = 'approved', owner_reviewer = $2,
                    owner_reviewed_at = NOW(), decision_note = $3,
                    updated_at = NOW()
                WHERE id = $1 AND state = 'profile_approved'
                RETURNING {_PROMOTION_COLUMNS}
                """,
                promotion_id,
                principal.user_id,
                note,
            )
            if row is None:  # pragma: no cover - lost race
                raise PromotionError(f"Proposal {promotion_id} changed underneath")
            await conn.execute(
                f"""
                INSERT INTO {SHARED_SKILLS_TABLE}
                    (skill_name, origin_profile, promotion_id, score,
                     body_sha256, promoted_by, promoted_at, last_scored_at,
                     demoted_at, demote_reason)
                VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW(), NULL, '')
                ON CONFLICT (skill_name) DO UPDATE SET
                    origin_profile = EXCLUDED.origin_profile,
                    promotion_id = EXCLUDED.promotion_id,
                    score = EXCLUDED.score,
                    body_sha256 = EXCLUDED.body_sha256,
                    promoted_by = EXCLUDED.promoted_by,
                    promoted_at = NOW(),
                    last_scored_at = NOW(),
                    demoted_at = NULL,
                    demote_reason = ''
                """,
                candidate.skill_name,
                candidate.origin_profile,
                candidate.id,
                candidate.score,
                candidate.body_sha256,
                principal.user_id,
            )
            await self._audit(
                conn,
                promotion_id,
                action="approved",
                principal=principal,
                body_sha256=candidate.body_sha256,
                detail=(
                    f"installed into {shared_skills_dir()}"
                    + (f"; displaced {displaced.skill_name}" if displaced else "")
                ),
            )
            return _row_to_candidate(row), displaced
        finally:
            if own:
                await conn.close()

    async def reject(
        self,
        principal: "Principal",
        promotion_id: str,
        *,
        reason: str,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> PromotionCandidate:
        """Refuse a proposal at either stage. The row and its audit remain."""
        if principal.role not in PROFILE_REVIEWER_ROLES:
            raise PermissionError(
                f"Role {principal.role!r} may not decide promotions"
            )
        own = connection is None
        conn = connection or await self._connect()
        try:
            candidate = await self._require(conn, promotion_id)
            if candidate.state not in OPEN_STATES:
                raise PromotionError(
                    f"Proposal {promotion_id} is already {candidate.state}"
                )
            row = await conn.fetchrow(
                f"""
                UPDATE {PROMOTIONS_TABLE}
                SET state = 'rejected', decision_note = $2, updated_at = NOW()
                WHERE id = $1
                RETURNING {_PROMOTION_COLUMNS}
                """,
                promotion_id,
                reason,
            )
            await self._audit(
                conn,
                promotion_id,
                action="rejected",
                principal=principal,
                body_sha256=candidate.body_sha256,
                detail=reason,
            )
            return _row_to_candidate(row)
        finally:
            if own:
                await conn.close()

    async def _require(
        self, conn: "asyncpg.Connection", promotion_id: str
    ) -> PromotionCandidate:
        await self.initialize(connection=conn)
        row = await conn.fetchrow(
            f"SELECT {_PROMOTION_COLUMNS} FROM {PROMOTIONS_TABLE} WHERE id = $1",
            promotion_id,
        )
        if row is None:
            raise PromotionError(f"No promotion proposal {promotion_id}")
        return _row_to_candidate(row)

    # -- the cap ------------------------------------------------------------

    async def _make_room(
        self,
        conn: "asyncpg.Connection",
        principal: "Principal",
        candidate: PromotionCandidate,
    ) -> Optional[SharedSkill]:
        """Evict the weakest resident, but only for a strictly stronger entrant.

        Under the cap this does nothing. At the cap the comparison is strict:
        an equal score does not displace, because churn has a cost of its own
        (every profile's cached prefix changes) and a tie is not evidence.
        """
        residents = await self.shared_skills(connection=conn)
        if any(item.skill_name == candidate.skill_name for item in residents):
            return None
        if len(residents) < self._settings.max_shared_skills:
            return None
        weakest = min(residents, key=lambda item: (item.score, item.skill_name))
        if candidate.score <= weakest.score:
            raise PromotionError(
                f"The shared library is full ({self._settings.max_shared_skills} "
                f"skills) and {candidate.skill_name!r} scores "
                f"{candidate.score} against the weakest resident "
                f"{weakest.skill_name!r} at {weakest.score}. Promotion is "
                f"competitive: displace something or raise the cap in "
                f"config.yaml (goals.promotion.max_shared_skills)."
            )
        await self._demote_row(
            conn,
            principal,
            weakest.skill_name,
            reason=(
                f"displaced by {candidate.skill_name} "
                f"({candidate.score} > {weakest.score})"
            ),
        )
        return weakest

    async def demote(
        self,
        principal: "Principal",
        skill_name: str,
        *,
        reason: str,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> Optional[SharedSkill]:
        """Remove a skill from the shared library. Its origin copy is untouched.

        Demotion is not deletion: the profile that taught it keeps it, keeps
        using it, and can propose it again if it starts earning its space.
        """
        if not principal.is_owner:
            raise PermissionError("Only the owner may demote a shared skill")
        own = connection is None
        conn = connection or await self._connect()
        try:
            return await self._demote_row(conn, principal, skill_name, reason=reason)
        finally:
            if own:
                await conn.close()

    async def _demote_row(
        self,
        conn: "asyncpg.Connection",
        principal: "Principal",
        skill_name: str,
        *,
        reason: str,
    ) -> Optional[SharedSkill]:
        await self.initialize(connection=conn)
        row = await conn.fetchrow(
            f"""
            UPDATE {SHARED_SKILLS_TABLE}
            SET demoted_at = NOW(), demote_reason = $2
            WHERE skill_name = $1 AND demoted_at IS NULL
            RETURNING *
            """,
            skill_name,
            reason,
        )
        if row is None:
            return None
        self._uninstall(skill_name)
        promotion_id = row["promotion_id"]
        if promotion_id is not None:
            await self._audit(
                conn,
                str(promotion_id),
                action="demoted",
                principal=principal,
                detail=reason,
            )
        return _row_to_shared(row)

    async def demotion_candidates(
        self,
        *,
        now: Optional[datetime] = None,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> List[Tuple[SharedSkill, str]]:
        """Residents that have stopped earning their place, with the reason.

        Re-scoring is a digest-time job, not a per-turn one: the reason a
        shared skill costs anything is that it sits in every profile's stable
        prompt, and that cost is the same whether we re-score hourly or weekly.
        """
        moment = now or datetime.now(timezone.utc)
        stale: List[Tuple[SharedSkill, str]] = []
        for resident in await self.shared_skills(connection=connection):
            activity, _, last_used = local_activity(resident.skill_name)
            reference = last_used or resident.promoted_at
            if reference is None:
                continue
            if moment - reference < self._settings.demote_unused_after:
                continue
            days = int(self._settings.demote_unused_after.days)
            stale.append(
                (
                    resident,
                    f"no recorded use in {days} days (activity={activity})",
                )
            )
        return stale

    # -- the shared directory ----------------------------------------------

    def _install(self, source: Path, skill_name: str) -> Path:
        """Copy the reviewed skill directory into the shared library.

        Copies the *directory*, because a skill is its ``SKILL.md`` plus the
        scripts it references; a shared skill missing its helper script would
        fail in every profile at once.
        """
        target = contained_shared_path(skill_name)
        register_shared_dir()
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(source.parent, target)
        return target

    def _uninstall(self, skill_name: str) -> None:
        target = contained_shared_path(skill_name)
        if target.exists():
            shutil.rmtree(target, ignore_errors=True)


def _active_profile() -> str:
    from hermes_cli.profiles import get_active_profile_name

    return get_active_profile_name()


def digest_lines(
    candidates: Sequence[PromotionCandidate],
    demotions: Sequence[Tuple[SharedSkill, str]] = (),
    *,
    limit: int = 10,
) -> List[str]:
    """Plain-text lines for the weekly review, deliverable anywhere.

    No SMTP, no new channel: the digest is text, and it goes where the owner
    already looks (a notification, and ``hermes promotion digest``).
    """
    lines: List[str] = []
    for candidate in list(candidates)[:limit]:
        stage = (
            "awaiting owner"
            if candidate.state == "profile_approved"
            else f"awaiting {candidate.origin_profile} reviewer"
        )
        lines.append(
            f"{candidate.skill_name} (score {candidate.score:.2f}, from "
            f"{candidate.origin_profile}, {stage}) — {candidate.rationale or 'no rationale given'}"
        )
    for resident, reason in list(demotions)[:limit]:
        lines.append(f"demote {resident.skill_name}: {reason}")
    return lines


__all__ = [
    "DEFAULT_MAX_SHARED_SKILLS",
    "DEFAULT_THRESHOLD",
    "OPEN_STATES",
    "PROFILE_REVIEWER_ROLES",
    "PROMOTION_STATES",
    "PromotionBodyChangedError",
    "PromotionCandidate",
    "PromotionConsentError",
    "PromotionError",
    "PromotionSettings",
    "SharedSkill",
    "SkillPromotionStore",
    "body_hash",
    "contained_shared_path",
    "digest_lines",
    "find_local_skill",
    "local_activity",
    "register_shared_dir",
    "score_candidate",
    "shared_skills_dir",
]
