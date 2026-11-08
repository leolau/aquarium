"""Pin suggestions for the agent-home landing page.

On landing load the agent "reviews" the caller's most recent unpinned chats
and suggests unfinished or interesting ones to pin. The review is ONE
stateless, tool-less auxiliary model call (``call_llm(task="session_review")``,
the same channel ``agent/title_generator.py`` uses) over a few metadata
fields per chat. It never adds a message to, resumes or rebuilds any
conversation, so no conversation's cached prompt prefix is touched.

Results are cached per user in the profile's ``state.db``
(``session_pin_suggestions`` + a ``state_meta`` run record) and only
regenerated when the candidate set changed and the cache is old enough.
Without an auxiliary model (or with ``use_model: false``) a heuristic picks
chats whose last message went unanswered or that ended mid-task. Dismissed
suggestions stay dismissed.

Config (``config.yaml``)::

    landing:
      pin_suggestions:
        enabled: true
        use_model: true
        max_items: 3
        candidates: 8
        lookback_days: 14
        refresh_hours: 6
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)

TASK = "session_review"

DEFAULT_SETTINGS: Dict[str, Any] = {
    "enabled": True,
    "use_model": True,
    "max_items": 3,
    "candidates": 8,
    "lookback_days": 14,
    "refresh_hours": 6,
}

# A changed candidate *set* (a new chat appeared) may re-run sooner than the
# refresh window, but never more often than this.
NEW_SESSION_FLOOR_S = 10 * 60
MIN_SCORE = 0.5
_SNIPPET = 300

_NEXT_STEP_RE = re.compile(
    r"\b(next steps?|to ?do|let me know|shall i|should i|would you like|do you want|"
    r"once you|when you're ready|waiting (?:for|on) (?:you|your)|remaining)\b",
    re.IGNORECASE,
)

_PROMPT = (
    "You review a person's recent chats with their AI assistant and pick the ones "
    "worth pinning: unfinished work (the person or the assistant is waiting on the "
    "other, a task stopped part-way, open next steps) or clearly interesting, "
    "ongoing topics. Skip finished one-off questions and small talk.\n"
    "Each chat is given as `n`, title, message count, age and its last messages.\n"
    'Return ONLY JSON: {"suggestions": [{"n": <number>, "reason": "<= 80 chars, '
    'plain words, in the language of the chat>", "score": 0.0-1.0}]}. '
    "Return at most {max_items} items; an empty list is fine."
)


def load_settings(config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """``landing.pin_suggestions`` merged over the defaults.

    Accepts the short form ``landing: {pin_suggestions: false}`` too.
    """
    if config is None:
        try:
            from hermes_cli.config import load_config

            config = load_config() or {}
        except Exception:
            config = {}
    raw = ((config.get("landing") or {}) if isinstance(config, dict) else {}).get(
        "pin_suggestions", {}
    )
    settings = dict(DEFAULT_SETTINGS)
    if isinstance(raw, bool):
        settings["enabled"] = raw
    elif isinstance(raw, dict):
        for key, default in DEFAULT_SETTINGS.items():
            value = raw.get(key, default)
            if isinstance(default, bool):
                settings[key] = bool(value)
            else:
                try:
                    settings[key] = max(1, int(value))
                except (TypeError, ValueError):
                    settings[key] = default
    return settings


# ---------------------------------------------------------------------------
# Candidates and heuristic
# ---------------------------------------------------------------------------


def _clip(text: Any, n: int = _SNIPPET) -> str:
    value = re.sub(r"\s+", " ", str(text or "")).strip()
    try:
        from agent.redact import redact_sensitive_text

        value = redact_sensitive_text(value)
    except Exception:
        pass
    return value if len(value) <= n else value[: n - 1] + "…"


def collect_candidates(
    db, user_scope: Optional[str], user_id: str, settings: Dict[str, Any], now: float
) -> List[Dict[str, Any]]:
    """The N most recent unpinned, undismissed, unarchived chats with content.

    ``user_scope`` limits the review to chats that login may list (``None`` =
    every chat in the profile, the owner's view). Each candidate carries the
    id the client knows (``session_id``, the live compression tip) and the pin
    key (``root_id``).
    """
    pins = db.get_pins(user_id)
    decided = {
        r["session_id"] for r in db.get_pin_suggestion_rows(user_id) if r["status"] != "open"
    }
    since = now - settings["lookback_days"] * 86400
    want = settings["candidates"]
    rows = db.list_sessions_rich(
        exclude_sources=["cron"],
        limit=max(want * 4, 20),
        order_by_last_active=True,
        user_id=user_scope,
        min_message_count=2,
    )
    out: List[Dict[str, Any]] = []
    for s in rows:
        if (s.get("last_active") or 0) < since:
            continue
        root = s.get("_lineage_root_id") or s["id"]
        if root in pins or root in decided:
            continue
        tail = db.last_messages(s["id"], limit=4)
        if not tail:
            continue
        last_user = next((m for m in reversed(tail) if m["role"] == "user"), None)
        last_asst = next((m for m in reversed(tail) if m["role"] == "assistant"), None)
        out.append(
            {
                "session_id": s["id"],
                "root_id": root,
                "title": s.get("title") or None,
                "preview": s.get("preview") or "",
                "message_count": int(s.get("message_count") or 0),
                "last_active": s.get("last_active"),
                "end_reason": s.get("end_reason"),
                "last_role": tail[-1]["role"],
                "last_user": _clip(last_user["content"]) if last_user else "",
                "last_assistant": _clip(last_asst["content"]) if last_asst else "",
            }
        )
        if len(out) >= want:
            break
    return out


def heuristic_score(c: Dict[str, Any], now: float) -> tuple[float, str]:
    """A free score + reason for one candidate (the no-model fallback)."""
    score, reason = 0.0, ""
    if c["last_role"] == "user":
        score, reason = 0.7, "Unfinished: your last message has no reply yet"
    elif c.get("end_reason") in ("error", "interrupted", "cancelled", "timeout"):
        score, reason = 0.65, "Unfinished: the last run stopped part-way"
    elif c["last_assistant"].rstrip().endswith("?"):
        score, reason = 0.6, "Unfinished: the agent is waiting on your answer"
    elif _NEXT_STEP_RE.search(c["last_assistant"]):
        score, reason = 0.55, "Unfinished: ended with open next steps"
    if score:
        age_days = max(0.0, (now - float(c.get("last_active") or now)) / 86400)
        score += max(0.0, 0.15 - 0.02 * age_days)
        score += min(0.1, c["message_count"] / 200)
    return round(min(score, 1.0), 3), reason


def heuristic_review(candidates: List[Dict[str, Any]], max_items: int, now: float):
    scored = []
    for c in candidates:
        score, reason = heuristic_score(c, now)
        if score >= MIN_SCORE:
            scored.append({"session_id": c["root_id"], "reason": reason, "score": score})
    scored.sort(key=lambda x: x["score"], reverse=True)
    return scored[:max_items]


# ---------------------------------------------------------------------------
# Model review
# ---------------------------------------------------------------------------


def _age(now: float, ts: Any) -> str:
    hours = max(0.0, (now - float(ts or now)) / 3600)
    return f"{hours:.0f}h" if hours < 48 else f"{hours / 24:.0f}d"


def build_messages(candidates: List[Dict[str, Any]], max_items: int, now: float):
    blocks = []
    for i, c in enumerate(candidates, 1):
        blocks.append(
            f"n={i} | title: {c['title'] or c['preview'] or '(untitled)'} | "
            f"{c['message_count']} messages | last active {_age(now, c['last_active'])} ago | "
            f"last message from: {c['last_role']}\n"
            f"  last user: {c['last_user'] or '-'}\n"
            f"  last assistant: {c['last_assistant'] or '-'}"
        )
    return [
        {"role": "system", "content": _PROMPT.replace("{max_items}", str(max_items))},
        {"role": "user", "content": "\n\n".join(blocks)},
    ]


def parse_model_output(content: str, candidates: List[Dict[str, Any]], max_items: int):
    """Validate the model's JSON against the candidate list (unknown n dropped)."""
    try:
        from agent.agent_runtime_helpers import strip_think_blocks

        content = strip_think_blocks(None, content or "")
    except Exception:
        content = content or ""
    match = re.search(r"\{.*\}", content, re.DOTALL)
    if not match:
        raise ValueError("no JSON object in review output")
    data = json.loads(match.group(0))
    out, seen = [], set()
    for item in data.get("suggestions") or []:
        if not isinstance(item, dict):
            continue
        try:
            n = int(item.get("n"))
            score = float(item.get("score", 0))
        except (TypeError, ValueError):
            continue
        if not 1 <= n <= len(candidates) or n in seen or score < MIN_SCORE:
            continue
        seen.add(n)
        reason = _clip(item.get("reason") or "Worth coming back to", 80)
        out.append({"session_id": candidates[n - 1]["root_id"], "reason": reason, "score": round(min(score, 1.0), 3)})
    out.sort(key=lambda x: x["score"], reverse=True)
    return out[:max_items]


def model_review(candidates, max_items: int, now: float, llm: Optional[Callable] = None):
    """One tool-less aux call. Raises when no auxiliary model is configured."""
    if llm is None:
        from agent.auxiliary_client import call_llm as llm
    response = llm(
        task=TASK,
        messages=build_messages(candidates, max_items, now),
        max_tokens=600,
        temperature=0.2,
    )
    content = response.choices[0].message.content or ""
    return parse_model_output(content, candidates, max_items)


# ---------------------------------------------------------------------------
# Cache + orchestration
# ---------------------------------------------------------------------------


def _meta_key(user_id: str) -> str:
    return f"pin_review:{user_id}"


def _fingerprints(candidates: List[Dict[str, Any]]) -> tuple[str, str]:
    ids = sorted(c["root_id"] for c in candidates)
    full = sorted(f"{c['root_id']}:{c['message_count']}:{c['last_role']}" for c in candidates)
    h = lambda xs: hashlib.sha256("|".join(xs).encode()).hexdigest()[:16]  # noqa: E731
    return h(ids), h(full)


def read_run(db, user_id: str) -> Dict[str, Any]:
    try:
        return json.loads(db.get_meta(_meta_key(user_id)) or "{}") or {}
    except (TypeError, ValueError):
        return {}


def review_due(run: Dict[str, Any], candidates, settings, now: float) -> bool:
    if not run.get("ran_at"):
        return True
    ids_fp, full_fp = _fingerprints(candidates)
    age = now - float(run["ran_at"])
    if ids_fp != run.get("ids_fp"):
        return age >= NEW_SESSION_FLOOR_S
    if full_fp != run.get("full_fp"):
        return age >= settings["refresh_hours"] * 3600
    return False


def run_review(db, user_id: str, candidates, settings, now: Optional[float] = None, llm=None) -> str:
    """Review *candidates* and store the result; returns ``model`` or ``heuristic``."""
    now = now if now is not None else time.time()
    max_items = settings["max_items"]
    items, source = None, "heuristic"
    if candidates and settings["use_model"]:
        try:
            items = model_review(candidates, max_items, now, llm=llm)
            source = "model"
        except Exception as exc:
            logger.info("pin review: model unavailable, using heuristic (%s)", exc)
    if items is None:
        items = heuristic_review(candidates, max_items, now)
    db.replace_open_pin_suggestions(user_id, items, now=now)
    ids_fp, full_fp = _fingerprints(candidates)
    db.set_meta(
        _meta_key(user_id),
        json.dumps({"ran_at": now, "ids_fp": ids_fp, "full_fp": full_fp, "source": source}),
    )
    return source


_inflight: set = set()
_inflight_lock = threading.Lock()


def _review_in_background(db_path: Path, user_id: str, candidates, settings) -> bool:
    key = (str(db_path), user_id)
    with _inflight_lock:
        if key in _inflight:
            return False
        _inflight.add(key)

    def _work():
        from hermes_state import SessionDB

        try:
            bg = SessionDB(db_path=db_path)
            try:
                run_review(bg, user_id, candidates, settings)
            finally:
                bg.close()
        except Exception:
            logger.exception("pin review failed")
        finally:
            with _inflight_lock:
                _inflight.discard(key)

    threading.Thread(target=_work, name="pin-review", daemon=True).start()
    return True


def is_pending(db_path: Path, user_id: str) -> bool:
    with _inflight_lock:
        return (str(db_path), user_id) in _inflight


def get_suggestions(
    db,
    user_scope: Optional[str],
    user_id: str,
    *,
    settings: Optional[Dict[str, Any]] = None,
    now: Optional[float] = None,
    background: bool = True,
) -> Dict[str, Any]:
    """The open suggestions for *user_id*, refreshing the cache when due.

    Never blocks on the model when ``background`` is set: a due model review
    runs in a thread and the response says ``pending: true`` so the client
    re-reads shortly. A heuristic-only review is SQL-only and runs inline.
    """
    settings = settings or load_settings()
    now = now if now is not None else time.time()
    if not settings["enabled"]:
        return {"items": [], "generated_at": None, "enabled": False, "pending": False}
    candidates = collect_candidates(db, user_scope, user_id, settings, now)
    run = read_run(db, user_id)
    pending = False
    if review_due(run, candidates, settings, now):
        db_path = Path(db.db_path)
        if background and settings["use_model"] and candidates:
            pending = _review_in_background(db_path, user_id, candidates, settings) or is_pending(
                db_path, user_id
            )
        else:
            run_review(db, user_id, candidates, settings, now=now)
            run = read_run(db, user_id)
    by_root = {c["root_id"]: c for c in candidates}
    items = []
    for row in db.get_pin_suggestion_rows(user_id):
        c = by_root.get(row["session_id"])
        if row["status"] != "open" or c is None:
            continue
        items.append(
            {
                "session_id": c["session_id"],
                "title": c["title"] or (c["preview"] or None),
                "reason": row["reason"] or "Worth coming back to",
                "last_active": c["last_active"],
            }
        )
    return {
        "items": items[: settings["max_items"]],
        "generated_at": run.get("ran_at"),
        "source": run.get("source"),
        "enabled": True,
        "pending": pending,
    }
