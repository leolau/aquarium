"""Profile lifecycle: suggest, adopt, retire — an output of the learning loop.

Every other Phase-6 doc assumed an owner can name their sub-goals up front and
create a profile for each. They can't. Sub-goal structure is *discovered by
doing the work*, so profile creation must be an *output* of the same loop that
distils skills and watches where work clusters — not a setup step.

This module is the proposal layer over that loop. It follows the
``skill_promotion.py`` blueprint exactly: ``SCHEMA_SQL``, a frozen dataclass,
an async store taking ``SupabaseAppStore``, ``_audit()`` for C5, and
``digest_lines()`` for plain-text output. Suggestion generation reads evidence
already recorded, uses the aux LLM for dual role/goal naming, and is capped at
one open suggestion at a time. Adoption calls ``create_profile`` and seeds a
profile-tier sub-goal. Retire/merge use the existing export path.

Three properties from the FG-30 spec, each a decision the owner made:

* **Consent-first, never auto-created.** A suggestion is a proposal with
  evidence attached. Only the owner adopts, because a new profile is a change
  to the entity's goal tree. Dismissals are kept and latched on ``dedup_key``,
  so a dismissed suggestion is never re-proposed on the same evidence.
* **Monthly, one at a time.** The digest emits at most one suggestion per
  cycle — a second nudge trains the owner to dismiss without reading.
  Generation is its own monthly pass, skipped while any suggestion is still
  ``proposed``; rendering rides ``weekly_digest()`` so an open suggestion
  appears in every weekly review until it is reviewed.
* **Dual role/goal naming.** Each suggestion carries both ``proposed_role``
  and ``proposed_goal``. The role is for the human; the goal is what the goal
  tree hangs on and what retirement completes — a role has no end state.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import shutil
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import (
    TYPE_CHECKING,
    Any,
    Dict,
    List,
    Literal,
    Optional,
    Sequence,
    Tuple,
)

if TYPE_CHECKING:  # pragma: no cover - typing only
    import asyncpg

    from hermes_cli.access import Principal
    from hermes_cli.datastore import SupabaseAppStore
    from hermes_cli.goal_tree import GoalTreeStore
    from hermes_cli.skill_promotion import SkillPromotionStore

log = logging.getLogger(__name__)

SUGGESTIONS_TABLE = "profile_suggestions"
SUGGESTION_AUDIT_TABLE = "profile_suggestion_audit"

#: The suggestion lifecycle. ``proposed`` is the only open state.
SUGGESTION_STATES: Tuple[str, ...] = ("proposed", "adopted", "dismissed")

#: The single open state.
OPEN_STATE: Tuple[str, ...] = ("proposed",)

#: The reviewed trail: what the owner already acted on.
REVIEWED_STATES: Tuple[str, ...] = ("adopted", "dismissed")

#: How many reviewed rows the queue surface returns. The trail is a trace of
#: recent decisions, not an archive: it grows for the lifetime of the profile
#: and every row carries an ``evidence`` blob, so an uncapped read hands a
#: mobile screen an unbounded payload for a section that renders three fields.
REVIEWED_HISTORY_LIMIT = 20

#: How often generation runs — separate from FG-29's weekly digest clock.
DEFAULT_GENERATION_INTERVAL = timedelta(days=30)

#: How long a profile with no sessions is "idle" before the digest flags it.
DEFAULT_IDLE_WEEKS = 4

SCHEMA_SQL = f"""
CREATE TABLE IF NOT EXISTS {SUGGESTIONS_TABLE} (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    proposed_name TEXT NOT NULL,       -- the profile identifier/slug
    proposed_role TEXT NOT NULL,       -- role-style name, e.g. "CFO"
    proposed_goal TEXT NOT NULL,       -- the sub-goal it would serve, e.g. "improve cashflow"
    parent_goal_id UUID NULL REFERENCES goals(id) ON DELETE SET NULL,
    rationale TEXT NOT NULL DEFAULT '',
    evidence JSONB NOT NULL DEFAULT '{{}}'::jsonb,
    dedup_key TEXT NOT NULL,          -- stable key over the evidence; latches a dismissal
    origin_profile TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'proposed',
    reviewed_by TEXT NULL,
    reviewed_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE {SUGGESTIONS_TABLE}
    DROP CONSTRAINT IF EXISTS {SUGGESTIONS_TABLE}_status_check;
ALTER TABLE {SUGGESTIONS_TABLE}
    ADD CONSTRAINT {SUGGESTIONS_TABLE}_status_check
    CHECK (status IN ({", ".join(f"'{s}'" for s in SUGGESTION_STATES)}));
-- One open suggestion at a time (the cap). A second would read as a list, and
-- lists get skimmed and batch-dismissed — killing the good one with the noise.
CREATE UNIQUE INDEX IF NOT EXISTS {SUGGESTIONS_TABLE}_one_open
    ON {SUGGESTIONS_TABLE} (origin_profile)
    WHERE status = 'proposed';
CREATE INDEX IF NOT EXISTS {SUGGESTIONS_TABLE}_status_idx
    ON {SUGGESTIONS_TABLE} (status, created_at);
CREATE INDEX IF NOT EXISTS {SUGGESTIONS_TABLE}_dedup_idx
    ON {SUGGESTIONS_TABLE} (dedup_key, status);

-- Append-only. Every state change, with who and what they were looking at.
-- A dismissed suggestion keeps its rows: "we considered this and said no" is
-- the answer to the same evidence being proposed again next month.
CREATE TABLE IF NOT EXISTS {SUGGESTION_AUDIT_TABLE} (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    suggestion_id UUID NOT NULL REFERENCES {SUGGESTIONS_TABLE}(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    actor_user_id TEXT NOT NULL,
    actor_role TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS {SUGGESTION_AUDIT_TABLE}_suggestion_idx
    ON {SUGGESTION_AUDIT_TABLE} (suggestion_id, at);
"""

_SUGGESTION_COLUMNS = (
    "id, proposed_name, proposed_role, proposed_goal, parent_goal_id, "
    "rationale, evidence, dedup_key, origin_profile, status, reviewed_by, "
    "reviewed_at, created_at"
)


class SuggestionError(RuntimeError):
    """A refused suggestion operation."""


@dataclass(frozen=True)
class ProfileSuggestion:
    """A suggestion as stored."""

    id: str
    proposed_name: str
    proposed_role: str
    proposed_goal: str
    parent_goal_id: Optional[str]
    rationale: str
    evidence: Dict[str, Any]
    dedup_key: str
    origin_profile: str
    status: str
    reviewed_by: Optional[str]
    reviewed_at: Optional[datetime]
    created_at: Optional[datetime]

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "proposed_name": self.proposed_name,
            "proposed_role": self.proposed_role,
            "proposed_goal": self.proposed_goal,
            "parent_goal_id": self.parent_goal_id,
            "rationale": self.rationale,
            "evidence": self.evidence,
            "dedup_key": self.dedup_key,
            "origin_profile": self.origin_profile,
            "status": self.status,
            "reviewed_by": self.reviewed_by,
            "reviewed_at": self.reviewed_at.isoformat() if self.reviewed_at else None,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }

    def as_summary_dict(self) -> dict:
        """The reviewed-trail projection: what a decision *was*, nothing more.

        Deliberately omits ``evidence``, which per §4.2 T3 carries the
        ``participants`` roster — ``user_id``, display name and role of every
        active principal. The full row is the material for a decision the owner
        has not made yet; once reviewed, the trail renders status, role and goal,
        so shipping the roster to every enrolled reader of the queue screen
        would be a disclosure with no reader.
        """
        return {
            "id": self.id,
            "proposed_name": self.proposed_name,
            "proposed_role": self.proposed_role,
            "proposed_goal": self.proposed_goal,
            "status": self.status,
            "reviewed_by": self.reviewed_by,
            "reviewed_at": self.reviewed_at.isoformat() if self.reviewed_at else None,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }


def _row_to_suggestion(row) -> ProfileSuggestion:
    evidence = row["evidence"]
    if isinstance(evidence, str):
        try:
            evidence = json.loads(evidence)
        except (json.JSONDecodeError, TypeError):
            evidence = {}
    if not isinstance(evidence, dict):
        evidence = {}
    return ProfileSuggestion(
        id=str(row["id"]),
        proposed_name=str(row["proposed_name"]),
        proposed_role=str(row["proposed_role"]),
        proposed_goal=str(row["proposed_goal"]),
        parent_goal_id=str(row["parent_goal_id"]) if row["parent_goal_id"] else None,
        rationale=str(row["rationale"]),
        evidence=evidence,
        dedup_key=str(row["dedup_key"]),
        origin_profile=str(row["origin_profile"]),
        status=str(row["status"]),
        reviewed_by=str(row["reviewed_by"]) if row["reviewed_by"] else None,
        reviewed_at=row["reviewed_at"],
        created_at=row["created_at"],
    )


def evidence_identity(evidence: Dict[str, Any]) -> Dict[str, Any]:
    """The part of the evidence that identifies *which cluster* this is.

    Hashing the whole evidence blob does not latch anything: it carries skill
    use *counts*, a participant list and the profile description, all of which
    move between cycles, so a dismissed suggestion would return next month
    under a different key on the same cluster — sprawl by nagging, the failure
    mode FG-30 §1 exists to design against.

    So identity is the *work*: which skills and which unparented goals. Counts,
    prose and the roster corroborate a cluster but do not define one — a new
    member joining must not un-dismiss a proposal the owner already refused.
    """
    skills = sorted(
        str(s.get("name", ""))
        for s in evidence.get("top_skills") or []
        if isinstance(s, dict) and s.get("name")
    )
    goals = sorted(
        str(g.get("id", ""))
        for g in evidence.get("orphan_goals") or []
        if isinstance(g, dict) and g.get("id")
    )
    return {"skills": skills, "orphan_goals": goals}


def _evidence_hash(evidence: Dict[str, Any]) -> str:
    """Stable sha256 over the evidence's *identity*, for the dedup_key."""
    canonical = json.dumps(
        evidence_identity(evidence), sort_keys=True, separators=(",", ":")
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _make_dedup_key(origin_profile: str, evidence: Dict[str, Any]) -> str:
    """Stable key over the evidence, latching a dismissal.

    Reuses the ``cron/suggestions.py`` contract (stable ``dedup_key`` so the
    same proposal is never re-offered after the user says no) rather than
    building a second latching mechanism.
    """
    return f"profile-suggest:{origin_profile}:{_evidence_hash(evidence)}"


# ---------------------------------------------------------------------------
# Suggestion generation
# ---------------------------------------------------------------------------

_SYSTEM_PROMPT = """You are a profile-suggestion engine for the Hermes Agent.

The owner runs one or more "profiles" — distinct agent identities, each with
their own skills, memory, and configuration. The system has noticed that work
in one profile is clustering into a distinct sub-goal that would benefit from
its own profile.

You are given evidence: skill clusters, goal patterns, and session topics that
look unlike the current profile's focus. Produce a single JSON object with
exactly these keys:

{
  "proposed_name": "<short slug, lowercase-hyphenated, e.g. 'finance'>",
  "proposed_role": "<role-style name, e.g. 'CFO' or 'Finance Manager'>",
  "proposed_goal": "<the sub-goal it would serve, e.g. 'improve cashflow'>",
  "rationale": "<1-2 sentences in the owner's language explaining the evidence>"
}

Rules:
  - proposed_name: a profile identifier (lowercase, alphanumeric, hyphens).
  - proposed_role: a role-shaped label. A role is for the human.
  - proposed_goal: the sub-goal. This is mandatory — retirement completes a
    goal, and a role has no end state.
  - Be concrete. Bad: "a new profile for work stuff."
                  Good: "Finance work — invoicing, cashflow, tax — is
                         unrelated to the product-building focus."
  - No code fences, no preamble. Output only JSON.
"""

_USER_TEMPLATE = """Current profile: {origin_profile}
Current profile description: {description}
Evidence:
{evidence_text}
"""


async def generate_suggestion(
    tree: "GoalTreeStore",
    promotions: "SkillPromotionStore",
    principal: "Principal",
    *,
    origin_profile: Optional[str] = None,
    interval: timedelta = DEFAULT_GENERATION_INTERVAL,
    now: Optional[datetime] = None,
    connection: Optional["asyncpg.Connection"] = None,
) -> Optional[ProfileSuggestion]:
    """Generate at most one suggestion per monthly cycle.

    Reads signals already recorded (no new instrumentation), uses the aux LLM
    for dual role/goal naming, and checks that no dismissed suggestion with
    the same ``dedup_key`` exists. Returns the persisted suggestion, or None
    if no cluster is strong enough or the one-open cap is already filled.

    This is the *monthly* generation pass — separate from FG-29's weekly
    digest clock. It is skipped entirely while a suggestion is still
    ``proposed`` (the one-open cap is simpler and stronger than a per-run limit).
    """
    profile = origin_profile or _active_profile()
    store = ProfileSuggestionStore(_resolve_store())

    own = connection is None
    conn = connection or await store._connect()
    try:
        await store.initialize(connection=conn)

        # Skip if the one-open cap is already filled.
        existing = await store._open_suggestion(conn, origin_profile=profile)
        if existing is not None:
            return existing

        # The monthly clock. Without it the cap alone bounds nothing: a
        # dismissal frees the one open slot, so the next pass — weekly, or
        # whenever the owner runs the command — proposes again immediately,
        # which is the volume Leo's monthly decision refused.
        if not await _generation_due(conn, profile, interval=interval, now=now):
            return None

        # Collect evidence signals.
        evidence = await _gather_evidence(tree, principal, conn=conn)
        if not evidence or not _evidence_strong_enough(evidence):
            return None

        dedup_key = _make_dedup_key(profile, evidence)

        # Check that no dismissed suggestion with the same dedup_key exists.
        dismissed = await conn.fetchval(
            f"""
            SELECT 1 FROM {SUGGESTIONS_TABLE}
            WHERE dedup_key = $1 AND status = 'dismissed'
            """,
            dedup_key,
        )
        if dismissed:
            return None

        # Use the aux LLM for dual role/goal naming.
        naming = _ask_aux_llm(profile, evidence)
        if naming is None:
            return None

        # Persist.
        suggestion = await store.propose(
            principal,
            proposed_name=naming["proposed_name"],
            proposed_role=naming["proposed_role"],
            proposed_goal=naming["proposed_goal"],
            rationale=naming.get("rationale", ""),
            evidence=evidence,
            dedup_key=dedup_key,
            origin_profile=profile,
            connection=conn,
        )
        return suggestion
    finally:
        if own:
            await conn.close()


async def _generation_due(
    conn: "asyncpg.Connection",
    origin_profile: str,
    *,
    interval: timedelta = DEFAULT_GENERATION_INTERVAL,
    now: Optional[datetime] = None,
) -> bool:
    """Whether ``interval`` has elapsed since this profile last proposed.

    The last *proposal* is the clock — any status, so a dismissal does not reset
    it. No extra state: the row's ``created_at`` is the timestamp.
    """
    last = await conn.fetchval(
        f"SELECT MAX(created_at) FROM {SUGGESTIONS_TABLE} WHERE origin_profile = $1",
        origin_profile,
    )
    if last is None:
        return True
    moment = now or datetime.now(timezone.utc)
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    return (moment - last) >= interval


async def _gather_evidence(
    tree: "GoalTreeStore",
    principal: "Principal",
    *,
    conn: "asyncpg.Connection",
) -> Dict[str, Any]:
    """Read the four evidence signals from existing data."""
    evidence: Dict[str, Any] = {}

    # 1. Skill usage clusters
    try:
        from tools.skill_usage import load_usage

        records = load_usage()
        if records:
            sorted_records = sorted(
                records.items(),
                key=lambda kv: len(kv[1].get("uses", [])),
                reverse=True,
            )[:10]
            evidence["top_skills"] = [
                {"name": name, "uses": len(r.get("uses", []))}
                for name, r in sorted_records
                if len(r.get("uses", [])) > 0
            ]
    except Exception:
        pass

    # 2. Goal patterns — operational goals with no explicit parent (orphans)
    try:
        goals = await tree.registry.list_goals(
            principal, status="active", connection=conn
        )
        orphans = [
            {"id": g.id, "title": g.title, "tier": g.tier}
            for g in goals
            if not g.parent_goal_id and g.tier == "operational"
        ]
        if orphans:
            evidence["orphan_goals"] = orphans[:5]
    except Exception:
        pass

    # 3. Profile description (for divergence comparison)
    try:
        from hermes_cli import profiles as profiles_mod
        from hermes_constants import get_hermes_home
        from pathlib import Path as P

        if profile_dir := P(get_hermes_home()):
            meta = profiles_mod.read_profile_meta(profile_dir)
            evidence["current_description"] = meta.get("description", "")
    except Exception:
        pass

    # 4. Distinct participants
    try:
        rows = await conn.fetch(
            "SELECT user_id, display, role FROM principals WHERE active = true"
        )
        if rows:
            evidence["participants"] = [
                {"user_id": r["user_id"], "display": r["display"], "role": r["role"]}
                for r in rows
            ]
    except Exception:
        pass

    return evidence


def _evidence_strong_enough(evidence: Dict[str, Any]) -> bool:
    """Whether the evidence justifies a suggestion.

    Two signals is the bar, and the skill cluster is one of them — a proposal
    to split work needs *work* behind it, not metadata. The profile description
    deliberately does not count: every profile has one, so counting it made any
    profile with a single used skill clear the bar and turned "the system
    noticed a cluster" into "the system runs monthly".
    """
    skills = evidence.get("top_skills") or []
    if len(skills) < 2:
        return False
    corroborating = 0
    if evidence.get("orphan_goals"):
        corroborating += 1
    if len(evidence.get("participants") or []) > 1:
        corroborating += 1
    return corroborating >= 1


def _evidence_for_prompt(evidence: Dict[str, Any]) -> Dict[str, Any]:
    """The evidence slice sent to the aux LLM.

    ``participants`` (every active principal's ``user_id``, ``display`` and
    ``role``) is a *local* corroborating signal — it counts towards the
    evidence bar in ``_evidence_strong_enough`` — but it is deliberately
    **not** sent to a third-party model. Naming a profile does not need the
    roster, and shipping it would make every member's identity and role
    leave the box to a vendor each monthly pass (Leo's decision, FG-30 §4.2
    T3 Q1 — drop from the prompt, keep as a local signal).
    """
    return {k: v for k, v in evidence.items() if k != "participants"}


def _ask_aux_llm(
    origin_profile: str,
    evidence: Dict[str, Any],
) -> Optional[dict]:
    """Use the aux LLM to produce role + goal from the evidence.

    Mirrors ``profile_describer.py``'s lazy import + lenient parse pattern.
    Never raises for expected failure modes — returns None so generation
    can be skipped this cycle.

    The roster (``participants``) is stripped before the prompt is built —
    see ``_evidence_for_prompt``. It stays in ``evidence`` for the local
    bar and the stored JSONB; it just never reaches the model.
    """
    try:
        from agent.auxiliary_client import (
            get_auxiliary_extra_body,
            get_text_auxiliary_client,
        )
    except Exception as exc:
        log.debug("suggestion: auxiliary client import failed: %s", exc)
        return None

    try:
        client, aux_model = get_text_auxiliary_client("profile_suggestion")
    except Exception as exc:
        log.debug("suggestion: get_text_auxiliary_client failed: %s", exc)
        return None

    if client is None or not aux_model:
        return None

    evidence_text = json.dumps(_evidence_for_prompt(evidence), indent=2, default=str)
    user_msg = _USER_TEMPLATE.format(
        origin_profile=origin_profile,
        description=evidence.get("current_description", "(no description)"),
        evidence_text=evidence_text,
    )

    try:
        resp = client.chat.completions.create(
            model=aux_model,
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": user_msg},
            ],
            temperature=0.3,
            max_tokens=500,
            timeout=60,
            extra_body=get_auxiliary_extra_body() or None,
        )
    except Exception as exc:
        log.info("suggestion: API call failed (%s)", exc)
        return None

    try:
        raw = resp.choices[0].message.content or ""
    except Exception:
        return None

    parsed = _extract_json_blob(raw)
    if parsed is None:
        return None

    name = parsed.get("proposed_name")
    role = parsed.get("proposed_role")
    goal = parsed.get("proposed_goal")
    rationale = parsed.get("rationale", "")

    if not isinstance(name, str) or not name.strip():
        return None
    if not isinstance(role, str) or not role.strip():
        return None
    if not isinstance(goal, str) or not goal.strip():
        return None

    # Validate the slug — lowercase, alphanumeric, hyphens.
    canon = name.strip().lower()
    if not re.match(r"^[a-z0-9][a-z0-9-]*$", canon):
        return None

    return {
        "proposed_name": canon,
        "proposed_role": role.strip(),
        "proposed_goal": goal.strip(),
        "rationale": rationale.strip() if isinstance(rationale, str) else "",
    }


def _extract_json_blob(raw: str) -> Optional[dict]:
    if not raw:
        return None
    stripped = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw.strip(), flags=re.MULTILINE)
    first = stripped.find("{")
    last = stripped.rfind("}")
    if first == -1 or last == -1 or last <= first:
        return None
    candidate = stripped[first : last + 1]
    try:
        val = json.loads(candidate)
    except (ValueError, json.JSONDecodeError):
        return None
    if not isinstance(val, dict):
        return None
    return val


# ---------------------------------------------------------------------------
# The store
# ---------------------------------------------------------------------------


def _resolve_store() -> "SupabaseAppStore":
    """Resolve the active profile's SupabaseAppStore (C3 datastore routing).

    ``"prod"`` is hard-coded deliberately, not a routing bug: this is a
    one-tier (C3 ``supabase-app``) consumer and there is no dev/staging
    context on the profile-suggestion path. Consistent with the other C3
    consumers on this tier (FG-27). Leo's decision, FG-30 §4.2 T3 Q2: keep
    hard-coded; recorded here as an assumption rather than left implicit.
    """
    from hermes_cli.datastore import get_store

    return get_store("supabase-app", "prod")


def _active_profile() -> str:
    from hermes_cli.profiles import get_active_profile_name

    return get_active_profile_name()


#: Copied into an adopted profile: model/provider behaviour, per FG-30 §2.
#: Deliberately *not* ``.env`` (credentials, resolved DSN) and not the parent's
#: un-promoted local skills — §2 lists both as not inherited.
_INHERITED_CONFIG_FILE = "config.yaml"

#: Messaging credentials that make a profile channel-attached. A profile whose
#: own ``.env`` names none of these is channel-less — which is not the same
#: thing as "its gateway is not running right now".
_CHANNEL_ENV_KEYS: Tuple[str, ...] = (
    "TELEGRAM_BOT_TOKEN",
    "DISCORD_BOT_TOKEN",
    "SLACK_BOT_TOKEN",
    "WHATSAPP_ENABLED",
    "SIGNAL_HTTP_URL",
    "EMAIL_ADDRESS",
    "TWILIO_ACCOUNT_SID",
    "MATRIX_HOMESERVER_URL",
    "MATTERMOST_URL",
    "HASS_TOKEN",
    "DINGTALK_CLIENT_ID",
    "FEISHU_APP_ID",
    "WECOM_BOT_ID",
    "WECOM_CALLBACK_CORP_ID",
    "WEIXIN_ACCOUNT_ID",
    "QQ_APP_ID",
)


def inherit_profile_config(
    profile_dir: Path, *, parent_home: Optional[Path] = None
) -> None:
    """Give an adopted profile what FG-30 §2 says it inherits, and nothing else.

    Two things: the parent's ``config.yaml`` (model/provider behaviour), and the
    promoted-skill library — *registered* as an external dir at the shared tier,
    never copied, so "which copy is authoritative" stays unaskable.
    """
    from hermes_constants import (
        get_hermes_home,
        reset_hermes_home_override,
        set_hermes_home_override,
    )

    parent = parent_home if parent_home is not None else get_hermes_home()
    source = parent / _INHERITED_CONFIG_FILE
    target = profile_dir / _INHERITED_CONFIG_FILE
    if source.is_file() and not target.exists():
        shutil.copy2(source, target)

    token = set_hermes_home_override(profile_dir)
    try:
        from hermes_cli.skill_promotion import register_shared_dir

        register_shared_dir()
    except Exception as exc:
        log.warning("adopt: could not register the shared skill library: %s", exc)
    finally:
        reset_hermes_home_override(token)


def profile_has_channel(profile_dir: Path) -> bool:
    """Whether this profile's own ``.env`` configures a messaging channel.

    Read from the file rather than the process environment: the process belongs
    to whoever launched it, and under FG-28's one-process model that is not the
    profile being reported on.
    """
    env_path = profile_dir / ".env"
    try:
        text = env_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        if key.strip() in _CHANNEL_ENV_KEYS and value.strip().strip("\"'"):
            return True
    return False


class ProfileSuggestionStore:
    """The suggestion queue and audit trail.

    Routed through the same profile-derived ``SupabaseAppStore`` as every
    other C3 consumer, so the queue for a profile lives in that profile's
    schema — a suggestion is *about* creating a profile from that profile's
    work, and its reviewer is that profile's owner.
    """

    def __init__(self, store: "SupabaseAppStore") -> None:
        from hermes_cli.datastore import SupabaseAppStore

        if not isinstance(store, SupabaseAppStore):
            raise TypeError("ProfileSuggestionStore requires a supabase-app store")
        self._store = store

    async def _connect(self) -> "asyncpg.Connection":
        conn = await self._store.connect()
        await conn.execute(f'CREATE SCHEMA IF NOT EXISTS "{self._store.schema}"')
        return conn

    async def initialize(
        self, *, connection: Optional["asyncpg.Connection"] = None
    ) -> None:
        """Create the suggestion tables (idempotent)."""
        own = connection is None
        conn = connection or await self._connect()
        try:
            await conn.execute(f'CREATE SCHEMA IF NOT EXISTS "{self._store.schema}"')
            await conn.execute(SCHEMA_SQL)
        finally:
            if own:
                await conn.close()

    # -- proposing ----------------------------------------------------------

    async def propose(
        self,
        principal: "Principal",
        *,
        proposed_name: str,
        proposed_role: str,
        proposed_goal: str,
        rationale: str = "",
        evidence: Dict[str, Any],
        dedup_key: str,
        origin_profile: str,
        parent_goal_id: Optional[str] = None,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> ProfileSuggestion:
        """Record a suggestion. Refuses if an open one already exists.

        The one-open cap is enforced by the unique partial index, so a second
        proposal on the same origin_profile fails at the database boundary.
        """
        if not proposed_name.strip():
            raise SuggestionError("proposed_name is required")
        if not proposed_role.strip():
            raise SuggestionError("proposed_role is required")
        if not proposed_goal.strip():
            raise SuggestionError("proposed_goal is required")
        if not dedup_key.strip():
            raise SuggestionError("dedup_key is required")

        own = connection is None
        conn = connection or await self._connect()
        try:
            await self.initialize(connection=conn)

            # Check for an existing open suggestion (the cap).
            existing = await self._open_suggestion(conn, origin_profile=origin_profile)
            if existing is not None:
                return existing

            # Dismissal latch: a dismissed suggestion with the same
            # dedup_key can never be re-proposed.  The row stays so the
            # same evidence being proposed again next month can be refused
            # at the store boundary — "we considered this and said no."
            dismissed = await conn.fetchval(
                f"""
                SELECT 1 FROM {SUGGESTIONS_TABLE}
                WHERE dedup_key = $1 AND status = 'dismissed'
                """,
                dedup_key,
            )
            if dismissed:
                raise SuggestionError(
                    f"A suggestion with dedup_key {dedup_key!r} was "
                    f"already dismissed — the evidence was considered "
                    f"and rejected"
                )

            row = await conn.fetchrow(
                f"""
                INSERT INTO {SUGGESTIONS_TABLE}
                    (proposed_name, proposed_role, proposed_goal, parent_goal_id,
                     rationale, evidence, dedup_key, origin_profile)
                VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
                RETURNING {_SUGGESTION_COLUMNS}
                """,
                proposed_name.strip(),
                proposed_role.strip(),
                proposed_goal.strip(),
                parent_goal_id,
                rationale,
                json.dumps(evidence),
                dedup_key,
                origin_profile,
            )
            suggestion = _row_to_suggestion(row)
            await self._audit(
                conn,
                suggestion.id,
                action="proposed",
                principal=principal,
                detail=f"role={proposed_role} goal={proposed_goal}",
            )
            return suggestion
        finally:
            if own:
                await conn.close()

    async def _audit(
        self,
        conn: "asyncpg.Connection",
        suggestion_id: str,
        *,
        action: str,
        principal: "Principal",
        detail: str = "",
    ) -> None:
        await conn.execute(
            f"""
            INSERT INTO {SUGGESTION_AUDIT_TABLE}
                (suggestion_id, action, actor_user_id, actor_role, detail)
            VALUES ($1, $2, $3, $4, $5)
            """,
            suggestion_id,
            action,
            principal.user_id,
            principal.role,
            detail,
        )

    async def audit_trail(
        self,
        suggestion_id: str,
        *,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> List[dict]:
        """Every recorded action for one suggestion, oldest first."""
        own = connection is None
        conn = connection or await self._connect()
        try:
            rows = await conn.fetch(
                f"""
                SELECT action, actor_user_id, actor_role, detail, at
                FROM {SUGGESTION_AUDIT_TABLE}
                WHERE suggestion_id = $1
                ORDER BY at, action
                """,
                suggestion_id,
            )
            return [dict(row) for row in rows]
        finally:
            if own:
                await conn.close()

    # -- reading ------------------------------------------------------------

    async def get(
        self,
        principal: "Principal",
        suggestion_id: str,
        *,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> Optional[ProfileSuggestion]:
        """One suggestion by id."""
        own = connection is None
        conn = connection or await self._connect()
        try:
            await self.initialize(connection=conn)
            row = await conn.fetchrow(
                f"SELECT {_SUGGESTION_COLUMNS} FROM {SUGGESTIONS_TABLE} WHERE id = $1",
                suggestion_id,
            )
            return _row_to_suggestion(row) if row else None
        finally:
            if own:
                await conn.close()

    async def list_suggestions(
        self,
        principal: "Principal",
        *,
        statuses: Sequence[str] = OPEN_STATE,
        limit: Optional[int] = None,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> List[ProfileSuggestion]:
        """Suggestions in ``statuses``, newest first, at most ``limit`` rows.

        ``limit`` is a SQL ``LIMIT``, not a slice of a full fetch: the reviewed
        trail is unbounded over a profile's life and each row carries evidence.
        """
        own = connection is None
        conn = connection or await self._connect()
        try:
            await self.initialize(connection=conn)
            sql = f"""
                SELECT {_SUGGESTION_COLUMNS} FROM {SUGGESTIONS_TABLE}
                WHERE status = ANY($1::text[])
                ORDER BY created_at DESC
            """
            if limit is None:
                rows = await conn.fetch(sql, list(statuses))
            else:
                rows = await conn.fetch(sql + " LIMIT $2", list(statuses), int(limit))
            return [_row_to_suggestion(row) for row in rows]
        finally:
            if own:
                await conn.close()

    async def queue(
        self,
        principal: "Principal",
        *,
        reviewed_limit: int = REVIEWED_HISTORY_LIMIT,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> Tuple[List[ProfileSuggestion], List[ProfileSuggestion]]:
        """``(open, reviewed)`` for the queue surface, over one connection.

        Two reads rather than one over all statuses, because the two halves are
        not the same thing: the open card is the decision being asked for and
        needs its evidence; the reviewed trail is a trace of decisions already
        made, is capped, and is rendered from three fields. Splitting here also
        makes "open first, then reviewed" a property of the query rather than a
        claim the ``ORDER BY created_at DESC`` does not make.
        """
        own = connection is None
        conn = connection or await self._connect()
        try:
            open_rows = await self.list_suggestions(
                principal, statuses=OPEN_STATE, connection=conn
            )
            reviewed = await self.list_suggestions(
                principal,
                statuses=REVIEWED_STATES,
                limit=reviewed_limit,
                connection=conn,
            )
            return open_rows, reviewed
        finally:
            if own:
                await conn.close()

    async def digest_suggestion(
        self,
        principal: "Principal",
        *,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> Optional[ProfileSuggestion]:
        """The single open suggestion to render in the weekly digest, or None.

        The digest only *renders* — generation is a separate monthly pass.
        """
        own = connection is None
        conn = connection or await self._connect()
        try:
            await self.initialize(connection=conn)
            row = await conn.fetchrow(
                f"""
                SELECT {_SUGGESTION_COLUMNS} FROM {SUGGESTIONS_TABLE}
                WHERE status = 'proposed'
                ORDER BY created_at DESC
                LIMIT 1
                """
            )
            return _row_to_suggestion(row) if row else None
        finally:
            if own:
                await conn.close()

    async def _open_suggestion(
        self,
        conn: "asyncpg.Connection",
        *,
        origin_profile: str,
    ) -> Optional[ProfileSuggestion]:
        """The single open suggestion for a profile, or None."""
        await self.initialize(connection=conn)
        row = await conn.fetchrow(
            f"""
            SELECT {_SUGGESTION_COLUMNS} FROM {SUGGESTIONS_TABLE}
            WHERE status = 'proposed' AND origin_profile = $1
            LIMIT 1
            """,
            origin_profile,
        )
        return _row_to_suggestion(row) if row else None

    async def _require(
        self, conn: "asyncpg.Connection", suggestion_id: str
    ) -> ProfileSuggestion:
        await self.initialize(connection=conn)
        row = await conn.fetchrow(
            f"SELECT {_SUGGESTION_COLUMNS} FROM {SUGGESTIONS_TABLE} WHERE id = $1",
            suggestion_id,
        )
        if row is None:
            raise SuggestionError(f"No profile suggestion {suggestion_id}")
        return _row_to_suggestion(row)

    # -- adoption -----------------------------------------------------------

    async def adopt(
        self,
        principal: "Principal",
        suggestion_id: str,
        *,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> Tuple[ProfileSuggestion, Path]:
        """Owner-only: adopt a suggestion → create the profile + seed sub-goal.

        Creates the profile with **no clone source**, then inherits exactly the
        two things FG-30 §2 lists as inherited: model/provider config, and the
        promoted-skill library at the shared tier (registered as an external
        dir, not copied). ``clone_config=True`` cannot serve that: it also
        copies the parent's ``.env`` and its *un-promoted* local skills, both of
        which §2 lists as **not** inherited — and a copied ``.env`` carries the
        parent's credentials and resolved DSN into a profile FG-27 expects to
        derive its own.

        The person-level ``USER.md`` needs no work — FG-24 put it at
        ``<root>/persons/<user_id>/USER.md``, outside any profile home.
        We assert it is visible; we do NOT copy it (a copy would reintroduce
        the drift bug that amendment removed).

        Returns the updated suggestion and the new profile directory.
        """
        if not principal.is_owner:
            raise PermissionError(
                "Only the owner may adopt a profile suggestion: a new profile "
                "is a change to the entity's goal tree"
            )
        own = connection is None
        conn = connection or await self._connect()
        try:
            suggestion = await self._require(conn, suggestion_id)
            if suggestion.status != "proposed":
                raise SuggestionError(
                    f"Suggestion {suggestion_id} is {suggestion.status}, not "
                    f"awaiting adoption"
                )

            # Create the profile — reuses the existing function.
            from hermes_cli.profiles import create_profile

            profile_dir = create_profile(
                name=suggestion.proposed_name,
                description=suggestion.proposed_role,
                verify_datastore=True,
                report=print,
            )
            inherit_profile_config(profile_dir)

            # Publish the entity goal into the new profile (FG-29 §3), then
            # ladder the new profile's own sub-goal beneath that copy. Both run
            # from *this* profile's context: `publish_entity_goal` reads the
            # entity goal here and crosses into the target itself through
            # `connect_for_publish`, the one sanctioned door. Running it under a
            # home override pointed at the new profile would look for the
            # entity goal in the new (empty) schema and skip the target as its
            # own origin — publishing nothing.
            await self._seed_new_profile_goals(
                principal,
                profile=suggestion.proposed_name,
                goal=suggestion.proposed_goal,
                role=suggestion.proposed_role,
            )

            # Mark the suggestion as adopted.
            row = await conn.fetchrow(
                f"""
                UPDATE {SUGGESTIONS_TABLE}
                SET status = 'adopted', reviewed_by = $2, reviewed_at = NOW()
                WHERE id = $1 AND status = 'proposed'
                RETURNING {_SUGGESTION_COLUMNS}
                """,
                suggestion_id,
                principal.user_id,
            )
            if row is None:  # pragma: no cover - lost race
                raise SuggestionError(f"Suggestion {suggestion_id} changed underneath")
            suggestion = _row_to_suggestion(row)
            await self._audit(
                conn,
                suggestion_id,
                action="adopted",
                principal=principal,
                detail=(
                    f"created profile {suggestion.proposed_name} at {profile_dir}; "
                    f"sub-goal: {suggestion.proposed_goal}"
                ),
            )
            return suggestion, profile_dir
        finally:
            if own:
                await conn.close()

    async def _seed_new_profile_goals(
        self,
        principal: "Principal",
        *,
        profile: str,
        goal: str,
        role: str,
    ) -> None:
        """Publish the entity goal into ``profile`` and ladder its sub-goal.

        Failures are reported, not fatal: the profile exists on disk by now and
        the suggestion is being adopted either way. But they are reported
        loudly, because a profile whose sub-goal is missing is exactly the
        "profile with nothing to hang off" FG-30 §2 is designed to prevent.
        """
        from hermes_cli.datastore import connect_for_publish
        from hermes_cli.goal_registry import GoalRegistryStore
        from hermes_cli.goal_tree import GoalTreeStore

        registry = GoalRegistryStore(self._store)
        tree = GoalTreeStore(registry)
        parent_goal_id: Optional[str] = None
        try:
            published = await tree.publish_entity_goal(principal, profiles=[profile])
            if published:
                parent_goal_id = published[0].goal_id
        except Exception as exc:
            log.warning(
                "adopt: entity goal not published into %s: %s", profile, exc
            )

        # The sub-goal lives in the *new* profile's schema, reached through the
        # one sanctioned crossing rather than by re-pointing HERMES_HOME.
        try:
            conn = await connect_for_publish(self._store, profile=profile)
        except Exception as exc:
            log.warning("adopt: sub-goal not seeded for %s: %s", profile, exc)
            return
        try:
            await registry.initialize(connection=conn)
            await registry.create_goal(
                principal,
                goal,
                tier="profile",
                description=role,
                parent_goal_id=parent_goal_id,
                connection=conn,
            )
        except Exception as exc:
            log.warning("adopt: sub-goal not seeded for %s: %s", profile, exc)
        finally:
            await conn.close()

    async def dismiss(
        self,
        principal: "Principal",
        suggestion_id: str,
        *,
        reason: str = "",
        connection: Optional["asyncpg.Connection"] = None,
    ) -> ProfileSuggestion:
        """Owner-only: dismiss a suggestion. The row and audit remain.

        Dismissals are latched on ``dedup_key``: a dismissed suggestion is
        never re-proposed on the same evidence. The row stays so the same
        evidence being proposed again next month can be refused at the store
        boundary.
        """
        if not principal.is_owner:
            raise PermissionError(
                "Only the owner may dismiss a profile suggestion"
            )
        own = connection is None
        conn = connection or await self._connect()
        try:
            suggestion = await self._require(conn, suggestion_id)
            if suggestion.status != "proposed":
                raise SuggestionError(
                    f"Suggestion {suggestion_id} is already {suggestion.status}"
                )
            row = await conn.fetchrow(
                f"""
                UPDATE {SUGGESTIONS_TABLE}
                SET status = 'dismissed', reviewed_by = $2, reviewed_at = NOW()
                WHERE id = $1
                RETURNING {_SUGGESTION_COLUMNS}
                """,
                suggestion_id,
                principal.user_id,
            )
            await self._audit(
                conn,
                suggestion_id,
                action="dismissed",
                principal=principal,
                detail=reason,
            )
            return _row_to_suggestion(row)
        finally:
            if own:
                await conn.close()


# ---------------------------------------------------------------------------
# Retire and merge
# ---------------------------------------------------------------------------


#: The terminal status a retired profile's goals are moved to. Taken from the
#: registry's own vocabulary (``goal_registry.GOAL_STATUSES``) rather than
#: written out as prose: ``"completed"`` is not in it, and
#: ``GoalRegistryStore.set_status`` raises on an unknown value — which is
#: exactly how the live box retired a profile whose goals all stayed active.
RETIRED_GOAL_STATUS = "done"


@dataclass(frozen=True)
class RetireResult:
    """What a retirement actually achieved.

    Archiving and goal completion can fail independently, and the archive is
    made first — so the caller needs to be told which parts happened rather
    than reading a bare path as "all of it did".
    """

    archive: Path
    goals_completed: int
    goal_error: Optional[str] = None

    def __fspath__(self) -> str:
        return str(self.archive)

    def __str__(self) -> str:
        return str(self.archive)


async def retire_profile(
    name: str,
    principal: "Principal",
    *,
    promotions: "SkillPromotionStore",
    connection: Optional["asyncpg.Connection"] = None,
) -> RetireResult:
    """Owner-only: offer skills once, archive, release the channel, mark goals.

    1. Offer the profile's skills for promotion **once** — the only way its
       know-how survives. The marker is written after the archive succeeds, so a
       failed retirement can be retried instead of losing the one offer.
    2. Archive via ``export_profile`` (restorable).
    3. Release the channel: disable the gateway service.
    4. Mark the profile's goals ``done`` — the profile tier *and* the
       operational goals under it, which would otherwise stay active under a
       profile nobody runs.
    5. Do NOT delete the profile directory — the archive is restorable.

    Returns a :class:`RetireResult`: the archive exists even when step 4 could
    not run, and the caller must be able to tell those apart.
    """
    if not principal.is_owner:
        raise PermissionError(
            "Only the owner may retire a profile: it archives the profile, "
            "releases its channel and completes its goals"
        )

    from hermes_cli.profiles import export_profile, get_profile_dir, normalize_profile_name
    from hermes_constants import get_default_hermes_root

    canon = normalize_profile_name(name)
    profile_dir = get_profile_dir(canon)

    # 1. One-time promotion offer for local skills.
    retired_marker = profile_dir / ".retired"
    offer_made = retired_marker.exists()
    if not offer_made:
        await _offer_skills_for_promotion(
            profile_dir,
            principal,
            promotions=promotions,
            origin_profile=canon,
            rationale=f"retired from profile {canon}",
            connection=connection,
        )

    # 2. Archive via the existing export path.
    archive_dir = get_default_hermes_root() / "archives"
    archive_dir.mkdir(parents=True, exist_ok=True)
    output_path = str(archive_dir / f"{canon}.tar.gz")
    archive_path = export_profile(canon, output_path)
    if not offer_made:
        retired_marker.touch()

    # 3. Release the channel: disable the gateway service.
    _release_channel(canon, profile_dir)

    # 4. Mark the profile's goals done.
    completed, goal_error = await _complete_profile_goals(profile_dir, principal)

    return RetireResult(
        archive=Path(archive_path),
        goals_completed=completed,
        goal_error=goal_error,
    )


async def _offer_skills_for_promotion(
    profile_dir: Path,
    principal: "Principal",
    *,
    promotions: "SkillPromotionStore",
    origin_profile: str,
    rationale: str,
    connection: Optional["asyncpg.Connection"] = None,
) -> None:
    """Propose every local skill in ``profile_dir`` for promotion."""
    skills_dir = profile_dir / "skills"
    if not skills_dir.is_dir():
        return
    from agent.skill_utils import is_excluded_skill_path

    for skill_md in sorted(skills_dir.rglob("SKILL.md")):
        if is_excluded_skill_path(skill_md):
            continue
        skill_name = skill_md.parent.name
        try:
            await promotions.propose(
                principal,
                skill_name,
                rationale=rationale,
                origin_profile=origin_profile,
                connection=connection,
            )
        except Exception as exc:
            log.info("retire: could not propose skill %s: %s", skill_name, exc)


def _release_channel(canon: str, profile_dir: Path) -> None:
    """Stop and unregister the profile's gateway service, if it has one."""
    try:
        from hermes_cli.profiles import (
            _check_gateway_running,
            _cleanup_gateway_service,
            _maybe_unregister_gateway_service,
            _stop_gateway_process,
        )

        if _check_gateway_running(profile_dir):
            _cleanup_gateway_service(canon, profile_dir)
            _maybe_unregister_gateway_service(canon)
            _stop_gateway_process(profile_dir)
    except Exception as exc:
        log.warning("retire: could not release channel for %s: %s", canon, exc)


async def _complete_profile_goals(
    profile_dir: Path, principal: "Principal"
) -> Tuple[int, Optional[str]]:
    """Complete the retired profile's goals — in *that* profile's schema.

    Resolves the store *under* the home override, so the connection and the
    schema belong to the same profile. Reusing the caller's connection would run
    the update against the *calling* profile's schema — the scope/identity
    mispairing FG-28 §Re-read had to fix three times.
    """
    try:
        from hermes_cli.goal_registry import GoalRegistryStore
        from hermes_constants import (
            reset_hermes_home_override,
            set_hermes_home_override,
        )

        token = set_hermes_home_override(profile_dir)
        try:
            from hermes_cli.datastore import get_store

            # "prod" is hard-coded by decision (FG-30 §4.2 T3 Q2): the retire
            # path is a one-tier C3 consumer with no dev context. See
            # _resolve_store for the full reasoning.
            registry = GoalRegistryStore(get_store("supabase-app", "prod"))
            goals = await registry.list_goals(principal, status="active")
            profile_goal_ids = {g.id for g in goals if g.tier == "profile"}
            completed = 0
            for goal in goals:
                if goal.tier == "profile" or goal.parent_goal_id in profile_goal_ids:
                    await registry.set_status(
                        principal, goal.id, RETIRED_GOAL_STATUS
                    )
                    completed += 1
            return completed, None
        finally:
            reset_hermes_home_override(token)
    except Exception as exc:
        log.warning("retire: could not mark goals done: %s", exc)
        return 0, f"{type(exc).__name__}: {exc}"


async def merge_profiles(
    source: str,
    target: str,
    principal: "Principal",
    *,
    promotions: "SkillPromotionStore",
    connection: Optional["asyncpg.Connection"] = None,
) -> RetireResult:
    """Owner-only: the source's skills go through promotion; the source retires.

    A merge is a retirement with a stated destination, so it ends where a
    retirement ends: archived, channel released, goals completed. Archiving
    alone would leave the merged-away profile running its own bot against its
    own goals.

    Memory is NOT merged — for the §2 reason: deciding which memory card
    belongs to which half is a judgement no heuristic makes well.
    """
    if not principal.is_owner:
        raise PermissionError("Only the owner may merge profiles")

    from hermes_cli.profiles import get_profile_dir, normalize_profile_name

    source_canon = normalize_profile_name(source)
    target_canon = normalize_profile_name(target)
    source_dir = get_profile_dir(source_canon)
    if not get_profile_dir(target_canon).is_dir():
        raise SuggestionError(f"Merge target profile {target_canon!r} does not exist")

    # 1. The source's skills go through promotion — the shared tier is how the
    #    target gets them, so nothing is copied profile-to-profile.
    marker = source_dir / ".retired"
    if not marker.exists():
        await _offer_skills_for_promotion(
            source_dir,
            principal,
            promotions=promotions,
            origin_profile=source_canon,
            rationale=f"merged from {source_canon} into {target_canon}",
            connection=connection,
        )
        marker.touch()

    # 2. Archive, release the channel, complete the goals. Memory is not
    #    merged (FG-30 §2).
    return await retire_profile(
        source_canon,
        principal,
        promotions=promotions,
        connection=connection,
    )


# ---------------------------------------------------------------------------
# Idle detection
# ---------------------------------------------------------------------------


async def idle_profiles(
    *,
    now: Optional[datetime] = None,
    idle_weeks: int = DEFAULT_IDLE_WEEKS,
) -> List[Tuple[str, int]]:
    """Profiles with no sessions for ``idle_weeks`` weeks.

    Returns ``(profile_name, days_since_last_session)`` tuples. Used by the
    weekly digest so idle profiles don't get forgotten.
    """
    from hermes_cli.profiles import list_profiles
    from hermes_state import SessionDB

    moment = now or datetime.now(timezone.utc)
    cutoff_days = idle_weeks * 7
    idle: List[Tuple[str, int]] = []
    for p in list_profiles():
        try:
            db = SessionDB(db_path=p.path / "state.db", read_only=True)
            sessions = db.list_sessions_rich(limit=1, order_by_last_active=True)
            if not sessions:
                # Never used. Count from the profile's own age, so a profile
                # adopted this week is not reported idle on the day it is
                # created — which is exactly when FG-30 expects it to be empty.
                try:
                    created = datetime.fromtimestamp(
                        p.path.stat().st_mtime, tz=timezone.utc
                    )
                except OSError:
                    continue
                age = (moment - created).days
                if age >= cutoff_days:
                    idle.append((p.name, age))
                continue

            last = sessions[0].get("last_active")
            if last is None:
                continue
            if isinstance(last, str):
                last = datetime.fromisoformat(last)
            if last.tzinfo is None:
                last = last.replace(tzinfo=timezone.utc)
            days = (moment - last).days
            if days >= cutoff_days:
                idle.append((p.name, days))
        except Exception as exc:
            log.debug("idle scan skipped %s: %s", p.name, exc)
    return idle


# ---------------------------------------------------------------------------
# Commit-to-channel (FG-30 §4.2 T2)
# ---------------------------------------------------------------------------

#: Platforms whose identity is a single bot token. The collision check and
#: the write both key off this map. Channels with more complex credentials
#: (WhatsApp, Signal, email) are not committable through this path — they have
#: their own setup wizards — and are deliberately absent here.
_PLATFORM_TOKEN_KEYS: Dict[str, Tuple[str, ...]] = {
    "telegram": ("TELEGRAM_BOT_TOKEN",),
    "discord": ("DISCORD_BOT_TOKEN",),
    "slack": ("SLACK_BOT_TOKEN",),
}

#: The single shared-credential env name above is what makes a channel. On
#: commit the chosen platform's first key is written.
def _platform_token_key(platform: str) -> str:
    keys = _PLATFORM_TOKEN_KEYS.get(platform)
    if not keys:
        raise ValueError(
            f"commit-channel: platform '{platform}' is not supported here "
            f"(bot-token platforms: {sorted(_PLATFORM_TOKEN_KEYS)}). Use "
            f"`hermes gateway setup` for credential-platform setup."
        )
    return keys[0]


class ChannelCollisionError(Exception):
    """Raised when another profile already holds the token being committed."""

    def __init__(self, platform: str, holder: str) -> None:
        self.platform = platform
        self.holder = holder
        super().__init__(
            f"That {platform} token is already used by profile '{holder}'. "
            f"Give this profile its own token — one bot cannot be polled by two "
            f"profiles, and reusing it would interleave two sub-goals on one chat."
        )


class ChannelWriteError(RuntimeError):
    """Raised when the token did not land in the profile's ``.env``.

    ``config.save_env_value`` returns *silently* when the key is admin-managed
    (``is_managed()`` / ``managed_scope.is_env_managed(key)``) — it prints to
    stderr and returns. Without a read-back, ``commit_channel`` would report a
    successful commit over an unwritten ``.env``, which is worse than a refusal
    because the owner stops looking. The check is the read-back, not a trust in
    the writer's return value.
    """

    def __init__(self, profile: str, key: str) -> None:
        self.profile = profile
        self.key = key
        super().__init__(
            f"commit-channel: the {key} token was not written to profile "
            f"'{profile}' .env — the key may be managed by your administrator. "
            f"Run `hermes doctor` or check stderr above; the profile is still "
            f"channel-less."
        )


def _read_env_value(profile_dir: Path, key: str) -> Optional[str]:
    """Read a single ``.env`` value from a profile's own file (not the process)."""
    env_path = profile_dir / ".env"
    try:
        text = env_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        if k.strip() == key:
            return v.strip().strip("\"'") or None
    return None


class CollisionCheckUnavailable(RuntimeError):
    """Raised when the collision check cannot complete, so it must refuse.

    The previous behaviour returned ``None`` on any enumeration failure, which
    is fail-open: a filesystem state we do not understand produces "no collision",
    so the pre-write refusal disappears exactly when it is most needed. A
    refusal here tells the owner the check could not be completed — the gateway's
    ``EX_CONFIG`` stop stays the backstop, but it is not the UX.
    """

    def __init__(self, detail: str) -> None:
        super().__init__(
            f"commit-channel: could not check for a token collision ({detail}). "
            f"Refusing rather than committing a token whose uniqueness is "
            f"unverified — run `hermes doctor` and retry."
        )


def find_token_collision(
    platform: str,
    token: str,
    *,
    skip_profile: str,
) -> Optional[str]:
    """Return the name of another profile holding ``token`` (pre-write refusal).

    A pre-write refusal: the gateway's runtime same-token exit (``EX_CONFIG``
    via the finish script's permanent stop) is the backstop, not the UX —
    discovering a collision as "the service will not start" is a bad way to
    learn you pasted the wrong token. This names the holder up front.

    Per-platform, not global: two platforms may legitimately use the same-shaped
    string, so only the same platform's token key is compared. The token is
    matched exactly (it is a credential, not prose).

    Scope: profiles' own ``.env`` files, because that is where the box's units
    read from (``EnvironmentFile=<HERMES_HOME>/.env``). A token supplied to
    another profile's gateway through a unit's ``Environment=`` line is **not**
    visible here and is not detected — the process environment of *this* command
    cannot see another unit's environment, so checking it would catch nothing
    while reading like a guarantee. That path keeps the gateway's ``EX_CONFIG``
    permanent stop as its only net; see §4.3 F3.

    **Enumeration failure is a refusal, not a pass**: an unreadable profiles
    root raises :class:`CollisionCheckUnavailable` rather than returning
    ``None``. Returning ``None`` here would fail open, and the precise failure
    §4.2 T2 asks this check to prevent — two gateways polling one bot,
    interleaving two sub-goals on one chat — is exactly what slips through a
    fail-open gap.
    """
    token = (token or "").strip()
    if not token:
        return None
    key = _platform_token_key(platform)
    try:
        from hermes_cli.profiles import _get_default_hermes_home, _get_profiles_root

        candidates: List[Tuple[str, Path]] = []
        default_home = _get_default_hermes_home()
        if default_home.is_dir():
            candidates.append(("default", default_home))
        root = _get_profiles_root()
        if root.is_dir():
            for entry in sorted(root.iterdir()):
                if entry.is_dir() and entry.name != "default":
                    candidates.append((entry.name, entry))
    except Exception as exc:
        # Not "no collision" — the check could not be completed, so refuse.
        raise CollisionCheckUnavailable(
            f"profile enumeration failed: {exc}"
        ) from exc

    for name, path in candidates:
        if name == skip_profile:
            continue
        existing = _read_env_value(path, key)
        if existing and existing == token:
            return name

    return None


def commit_channel(
    profile_name: str,
    *,
    platform: str,
    token: str,
    allowed_users: Optional[str] = None,
    start_service: bool = True,
) -> Dict[str, Any]:
    """Give an adopted profile its own messaging channel (FG-30 §3, §4.2 T2).

    §3 says an adopted profile starts channel-less and "gains a channel when
    the owner commits" — nothing implemented that commit, so the owner had to
    hand-edit the new profile's ``.env`` and run the generic gateway commands,
    which is precisely the friction §3 exists to remove.

    This is composition, not new machinery. It:

    1. **refuses a token already used by another profile *before* writing it**,
       naming the holder (the gateway's ``EX_CONFIG`` permanent stop is the
       backstop, not the UX — see ``find_token_collision``);
    2. writes the platform's token into **that profile's own ``.env``** — never
       the process environment (#219/#220) — by overriding ``HERMES_HOME`` for
       the write so ``save_env_value`` lands in the right file;
    3. registers and starts the profile's gateway service (the service name is
       ``HERMES_HOME``-derived, so the override scopes it correctly), reusing
       the existing ``gateway install``/``start`` machinery; and
    4. reports the handle the owner should now message (best-effort — it needs
       the platform's API and a live network).

    Returns a dict with ``profile``, ``platform``, and ``handle`` (or
    ``handle: None`` when the lookup was skipped or failed).
    """
    from hermes_cli.profiles import get_profile_dir, normalize_profile_name

    canon = normalize_profile_name(profile_name)
    profile_dir = get_profile_dir(canon)
    if not profile_dir.is_dir():
        raise FileNotFoundError(
            f"commit-channel: profile '{canon}' does not exist at {profile_dir}"
        )
    token = (token or "").strip()
    if not token:
        raise ValueError("commit-channel: a non-empty token is required")

    # 1. Refuse a collision before touching the profile's .env.
    holder = find_token_collision(platform, token, skip_profile=canon)
    if holder is not None:
        raise ChannelCollisionError(platform, holder)

    # 2. Write into the profile's own .env under a HERMES_HOME override.
    from hermes_constants import (
        reset_hermes_home_override,
        set_hermes_home_override,
    )
    from hermes_cli.config import ensure_hermes_home, save_env_value

    override = set_hermes_home_override(profile_dir)
    try:
        ensure_hermes_home()
        key = _platform_token_key(platform)
        save_env_value(key, token)
        if platform == "telegram" and allowed_users:
            save_env_value("TELEGRAM_ALLOWED_USERS", allowed_users.replace(" ", ""))
        elif platform == "discord" and allowed_users:
            save_env_value("DISCORD_ALLOWED_GUILDS", allowed_users.replace(" ", ""))
    finally:
        reset_hermes_home_override(override)

    # F2: read the value back before reporting success. ``save_env_value``
    # returns silently when the key is admin-managed (it prints to stderr and
    # returns), so without a read-back we'd print "✓ has a channel" over an
    # unwritten .env — a successful-looking commit that configured nothing,
    # which is worse than a refusal because the owner stops looking.
    # ``profile_has_channel`` already exists in this module and is exactly the
    # assertion the doctor uses; the precise key check confirms *this* token
    # landed, not just any channel key.
    written = _read_env_value(profile_dir, key)
    if written != token:
        # Not "is there a value" but "is it *this* value": a profile whose .env
        # already held an older token for the same key would otherwise read back
        # truthy and report a successful commit while the gateway keeps serving
        # the previous bot — a wrong-channel success, which is the same lie the
        # read-back exists to prevent.
        raise ChannelWriteError(canon, key)

    # 3. Register + start the profile's gateway service (best-effort; the
    #    service manager may be unavailable in this environment — e.g. a test
    #    box without systemd — and that is not a reason to lose the write).
    #    F4: distinguish "skipped" (no service manager here) from "failed"
    #    (the manager was there but install/start did not leave it running),
    #    so ``--no-start`` and an operational failure do not read the same.
    service_status: ServiceStartStatus = "unavailable"
    if start_service:
        service_status = _start_profile_gateway(canon, profile_dir)

    # 4. Report the handle (best-effort). A failure here is not a failure of
    #    the commit — the channel is configured and the service is started.
    handle = _resolve_handle(platform, token) if start_service else None

    return {
        "profile": canon,
        "platform": platform,
        "handle": handle,
        "service_started": service_status == "started",
        "service_status": service_status,
        "channel_less": False,
    }


#: The outcome of trying to install+start the profile's gateway service.
#: ``"started"`` — service is running; ``"unavailable"`` — there is no service
#: manager on this platform (Termux, an unsupported OS), so the start was
#: *skipped*, not failed; ``"failed"`` — the service manager was there but the
#: install/start raised, or ran and the service is still not running. F4: the
#: CLI distinguishes "skipped" from "failed" so ``--no-start`` and a real
#: operational failure do not print the same line.
ServiceStartStatus = Literal["started", "unavailable", "failed"]


def _start_profile_gateway(canon: str, profile_dir: Path) -> ServiceStartStatus:
    """Install + start this profile's gateway service under a HOME override.

    Reuses ``hermes gateway install``/``start``: the service name is derived
    from ``HERMES_HOME`` (``get_service_name`` → ``_profile_suffix``), so
    overriding HOME scopes the slot to this profile. Returns a tri-state:

    * ``"started"`` — the service is installed and running.
    * ``"unavailable"`` — there is no service manager to use (Termux, or an
      OS the gateway has no install path for). This is a *skip*, not a failure:
      the credential is written and ``hermes doctor`` reports the profile as
      channel-configured-but-stopped with the exact start command.
    * ``"failed"`` — the service manager was present but install/start raised,
      or ran and left the service not-running. Distinct from ``--no-start``
      so the owner is told *which* happened and where to look (``gateway.log``).
    """
    try:
        from hermes_constants import (
            reset_hermes_home_override,
            set_hermes_home_override,
        )

        override = set_hermes_home_override(profile_dir)
        try:
            from hermes_cli.gateway import (
                _is_service_installed,
                _is_service_running,
                is_macos,
                is_termux,
                is_windows,
                launchd_start,
                supports_systemd_services,
                systemd_install,
                systemd_start,
            )

            def _installed() -> bool:
                return bool(_is_service_installed())

            if not _installed():
                if is_termux():
                    return "unavailable"
                if supports_systemd_services():
                    systemd_install()
                elif is_macos():
                    from hermes_cli.gateway import launchd_install

                    launchd_install()
                elif is_windows():
                    from hermes_cli import gateway_windows

                    if not _installed():
                        gateway_windows.install()
                else:
                    return "unavailable"
            if not _is_service_running():
                if supports_systemd_services():
                    systemd_start()
                elif is_macos():
                    launchd_start()
                elif is_windows():
                    from hermes_cli import gateway_windows

                    gateway_windows.start()
            return "started" if _is_service_running() else "failed"
        finally:
            reset_hermes_home_override(override)
    except Exception as exc:
        log.warning("commit-channel: could not start gateway service: %s", exc)
        return "failed"


def _resolve_handle(platform: str, token: str) -> Optional[str]:
    """Best-effort: ask the platform who this token belongs to, for the report.

    Network + the platform's API are required, neither of which a commit should
    depend on succeeding. Returns ``@username`` for telegram, the bot's id for
    the others, or ``None`` when the lookup is not attempted or fails.
    """
    if platform != "telegram":
        return None
    try:
        import httpx

        resp = httpx.get(
            f"https://api.telegram.org/bot{token}/getMe", timeout=10.0
        )
        if resp.status_code != 200:
            return None
        data = resp.json()
        if not data.get("ok"):
            return None
        me = data.get("result", {})
        uname = me.get("username")
        return f"@{uname}" if uname else str(me.get("id") or "") or None
    except Exception as exc:
        log.debug("commit-channel: could not resolve handle: %s", exc)
        return None


# ---------------------------------------------------------------------------
# Digest rendering
# ---------------------------------------------------------------------------


def digest_lines(suggestion: Optional[ProfileSuggestion]) -> List[str]:
    """Plain-text lines for the weekly review.

    The digest only *renders* an open suggestion — generation is a separate
    monthly pass. An open suggestion appears in every weekly review until the
    owner reviews it, because a suggestion held back returns next month but
    one dismissed unread never returns.
    """
    if suggestion is None:
        return []
    return [
        f"{suggestion.proposed_role} / {suggestion.proposed_goal} "
        f"(from {suggestion.origin_profile}) — "
        f"{suggestion.rationale or 'no rationale given'}"
    ]


def idle_lines(
    idle: Sequence[Tuple[str, int]],
) -> List[str]:
    """Plain-text lines for idle profiles in the weekly digest."""
    return [
        f"{name} (last session: {days} days ago)"
        for name, days in idle
    ]


__all__ = [
    "DEFAULT_GENERATION_INTERVAL",
    "DEFAULT_IDLE_WEEKS",
    "ChannelCollisionError",
    "ChannelWriteError",
    "CollisionCheckUnavailable",
    "OPEN_STATE",
    "REVIEWED_HISTORY_LIMIT",
    "REVIEWED_STATES",
    "commit_channel",
    "evidence_identity",
    "find_token_collision",
    "inherit_profile_config",
    "profile_has_channel",
    "ProfileSuggestion",
    "ProfileSuggestionStore",
    "SUGGESTION_STATES",
    "SuggestionError",
    "digest_lines",
    "generate_suggestion",
    "idle_lines",
    "idle_profiles",
    "merge_profiles",
    "retire_profile",
]
