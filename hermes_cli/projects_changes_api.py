"""HTTP routes for the Projects "change requirements" flow.

One composer for everything that changes after a project starts:

* ``POST /{slug}/changes`` records the change as a directive (its kinds and
  apply mode ride in ``project_directives.change_meta``), stops the open run
  when the change should apply now (finished cards and deliveries are kept —
  :func:`projects_run.stop_run` only reclaims running cards and archives
  un-started ones), and kicks the existing plan-draft job seeded with the
  change, the current requirements and the current plan.
* ``POST /{slug}/changes/{id}/draft`` re-drafts for a change (after a failed
  draft).
* ``POST /{slug}/changes/{id}/approve`` activates the drafted revision and
  starts the next run through the ordinary start path, so the one-open-run
  invariant holds (409 while one is open).
* ``GET /{slug}/changes`` is the history the Iterations tab groups: every
  directive (retired included) with its change metadata, and every run.

A change never reaches a conversation already in flight: directives and the
plan are compiled when a run *starts* (prompt caching is preserved). Writes
honour an ``Idempotency-Key`` header — a replay answers with the first
result instead of acting twice.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
import time
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request

from hermes_cli import kanban_db, projects_api, projects_db, projects_run
from hermes_cli.sqlite_util import write_txn

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/registry/projects")

VALID_CHANGE_KINDS = ("add", "direction", "output", "attach", "memory")
VALID_APPLY_MODES = ("now", "next", "record")
CHANGE_TEXT_MAX_CHARS = 4000
_IDEMPOTENCY_HEADER = "idempotency-key"
_READING_MAX_ITEMS = 10

# Serialises change writes so a double submit (same idempotency key) cannot
# record twice, and an approve cannot race itself into two runs.
_CHANGES_LOCK = threading.Lock()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _parse_meta(raw: Any) -> Optional[dict]:
    if not raw:
        return None
    try:
        meta = json.loads(raw)
    except (TypeError, ValueError):
        return None
    return meta if isinstance(meta, dict) else None


def _change_payload(row: dict) -> dict:
    """A directive row as the change flow presents it."""
    out = dict(row)
    meta = _parse_meta(out.pop("change_meta", None)) or {}
    out["kinds"] = list(meta.get("kinds") or [])
    out["apply"] = meta.get("apply")
    out["is_change"] = bool(meta)
    out["stopped_run"] = meta.get("stopped_run")
    out["draft_rev"] = meta.get("draft_rev")
    out["reading"] = meta.get("reading")
    out["approved"] = meta.get("approved")
    return out


def _get_directive(conn, project_id: str, directive_id: str) -> Optional[dict]:
    row = conn.execute(
        "SELECT * FROM project_directives WHERE id = ? AND project_id = ?",
        (directive_id, project_id),
    ).fetchone()
    return dict(row) if row else None


def _write_meta(conn, directive_id: str, meta: dict) -> None:
    with write_txn(conn):
        conn.execute(
            "UPDATE project_directives SET change_meta = ? WHERE id = ?",
            (json.dumps(meta), directive_id),
        )


def _update_meta(conn, directive_id: str, **fields: Any) -> dict:
    row = conn.execute(
        "SELECT change_meta FROM project_directives WHERE id = ?",
        (directive_id,),
    ).fetchone()
    meta = _parse_meta(row["change_meta"] if row else None) or {}
    meta.update(fields)
    _write_meta(conn, directive_id, meta)
    return meta


def _find_by_key(conn, project_id: str, key: str) -> Optional[dict]:
    rows = conn.execute(
        "SELECT * FROM project_directives WHERE project_id = ? "
        "AND change_meta IS NOT NULL",
        (project_id,),
    ).fetchall()
    for row in rows:
        meta = _parse_meta(row["change_meta"])
        if meta and meta.get("key") == key:
            return dict(row)
    return None


def _idempotency_key(request: Request) -> Optional[str]:
    key = (request.headers.get(_IDEMPOTENCY_HEADER) or "").strip()
    return key[:200] or None


def _draft_state(project_id: str) -> dict:
    with projects_api._PLAN_DRAFTS_LOCK:
        state = projects_api._PLAN_DRAFTS.get(project_id)
        return dict(state) if state else {"status": "idle"}


def _draft_running(project_id: str) -> bool:
    return _draft_state(project_id).get("status") == "running"


async def _json_body(request: Request) -> dict:
    if not request.headers.get("content-length"):
        return {}
    try:
        body = await request.json()
    except ValueError:
        raise HTTPException(status_code=422, detail="the body must be JSON")
    if not isinstance(body, dict):
        raise HTTPException(status_code=422, detail="the body must be a JSON object")
    return body


# ---------------------------------------------------------------------------
# The seeded plan draft
# ---------------------------------------------------------------------------


def _change_prompt(
    project,
    outputs: list[dict],
    requirements: list[dict],
    plan: Optional[dict],
    change: dict,
    kinds: list[str],
) -> str:
    lines = [projects_api._plan_draft_prompt(project, outputs)]
    lines += ["", "Current requirements (standing instructions):"]
    if requirements:
        for d in requirements:
            lines.append(f"- [{d['id']}] {d['body']}")
    else:
        lines.append("- (none beyond the brief)")
    if plan and plan.get("steps"):
        lines += ["", f"Current plan (rev {plan['rev']}):"]
        for i, step in enumerate(plan["steps"], 1):
            extra = f" — {step['body']}" if step.get("body") else ""
            lines.append(f"{i}. [{step.get('key')}] {step.get('title')}{extra}")
    lines += [
        "",
        "Requirement change from the user"
        + (f" (kinds: {', '.join(kinds)})" if kinds else "")
        + ":",
        change["body"],
        "",
        "Revise the plan for this change. Keep every step that still applies "
        "with the SAME key so finished work is reused; change or add only what "
        "the change needs. In the same JSON object add "
        '"reading": {"changes": ["<one short line per distinct requirement '
        'change>"], "affected_outputs": ["<exact title of an output above>"], '
        '"supersedes": ["<id in [brackets] of a current requirement this '
        'change replaces>"]}.',
    ]
    return "\n".join(lines)


def _normalise_reading(
    raw: Any, *, text: str, outputs: list[dict], requirements: list[dict]
) -> dict:
    raw = raw if isinstance(raw, dict) else {}

    def _strs(value: Any) -> list[str]:
        if not isinstance(value, list):
            return []
        return [str(v).strip() for v in value if str(v or "").strip()][
            :_READING_MAX_ITEMS
        ]

    changes = _strs(raw.get("changes"))
    if not changes:
        first = text.strip().splitlines()[0] if text.strip() else ""
        changes = [first[:160]] if first else []
    by_title = {str(o.get("title") or "").strip().lower(): o for o in outputs}
    affected: list[dict] = []
    for title in _strs(raw.get("affected_outputs")):
        out = by_title.get(title.lower())
        if out and all(a["id"] != out["id"] for a in affected):
            affected.append({"id": out["id"], "title": out["title"]})
    by_id = {d["id"]: d for d in requirements}
    supersedes: list[dict] = []
    for did in _strs(raw.get("supersedes")):
        did = did.strip("[]")
        d = by_id.get(did)
        if d and all(s["id"] != did for s in supersedes):
            supersedes.append({"id": did, "body": d["body"]})
    return {"changes": changes, "affected_outputs": affected, "supersedes": supersedes}


def _change_draft_job(
    *,
    project_id: str,
    change_id: str,
    text: str,
    prompt: str,
    outputs: list[dict],
    requirements: list[dict],
    assignee: Optional[str],
    profile_names: set[str],
    created_by: Optional[str],
) -> None:
    def _set(**fields: Any) -> None:
        with projects_api._PLAN_DRAFTS_LOCK:
            state = projects_api._PLAN_DRAFTS.get(project_id)
            if state is not None and state.get("change_id") == change_id:
                state.update(fields)

    try:
        data = projects_api._extract_json_object(projects_api._call_plan_model(prompt))
        steps = projects_api._normalise_draft_steps(
            data.get("steps"), assignee=assignee, profile_names=profile_names
        )
        reading = _normalise_reading(
            data.get("reading"), text=text, outputs=outputs, requirements=requirements
        )
        with projects_db.connect_closing() as conn:
            rev = projects_db.save_playbook_rev(
                conn,
                project_id=project_id,
                body=str(data.get("body") or "").strip(),
                steps=steps,
                created_by=created_by,
                note=f"drafted by the agent for change {change_id}",
            )
            _update_meta(conn, change_id, draft_rev=rev, reading=reading)
        _set(status="done", rev=rev, reading=reading, finished_at=int(time.time()))
    except Exception as exc:  # noqa: BLE001 — surfaced to the UI, not raised
        logger.warning("change draft failed for project %s: %s", project_id, exc)
        _set(
            status="failed",
            detail=projects_api._plan_draft_error_detail(exc),
            finished_at=int(time.time()),
        )


def _precheck_draft(conn, project) -> list[dict]:
    """Refuse before anything is recorded: a draft already running, or a
    project with no outputs to plan for."""
    if _draft_running(project.id):
        raise HTTPException(
            status_code=409,
            detail="the agent is already drafting a plan — wait for it to finish",
        )
    outputs = projects_db.get_project_outputs(conn, project.id)
    if not outputs:
        raise HTTPException(
            status_code=409,
            detail="declare at least one output before drafting a plan",
        )
    return outputs


def _start_change_draft(
    conn, project, profiles, change: dict, kinds: list[str], user_id: str,
    outputs: list[dict],
) -> dict:
    requirements = [
        d
        for d in projects_db.list_project_directives(conn, project.id)
        if d["kind"] == "directive" and d["id"] != change["id"]
    ]
    plan = projects_db.get_playbook(conn, project.id)
    profile_names = {p["profile"] for p in profiles}
    assignee = project.host_profile or (
        sorted(profile_names)[0] if profile_names else None
    )
    state = {
        "status": "running",
        "started_at": int(time.time()),
        "change_id": change["id"],
    }
    with projects_api._PLAN_DRAFTS_LOCK:
        current = projects_api._PLAN_DRAFTS.get(project.id)
        if current and current.get("status") == "running":
            return dict(current)
        projects_api._PLAN_DRAFTS[project.id] = state
        # Snapshot before the job starts: it updates ``state`` in place and
        # can finish before this function returns.
        started = dict(state)
    threading.Thread(
        target=_change_draft_job,
        kwargs={
            "project_id": project.id,
            "change_id": change["id"],
            "text": change["body"],
            "prompt": _change_prompt(
                project, outputs, requirements, plan, change, kinds
            ),
            "outputs": outputs,
            "requirements": requirements,
            "assignee": assignee,
            "profile_names": profile_names,
            "created_by": user_id,
        },
        name=f"change-draft-{project.slug}",
        daemon=True,
    ).start()
    return started


def _parse_change_body(body: dict) -> tuple[str, list[str], str]:
    text = str(body.get("text") or "").strip()
    if not text:
        raise HTTPException(status_code=422, detail="describe what is changing")
    if len(text) > CHANGE_TEXT_MAX_CHARS:
        raise HTTPException(
            status_code=422,
            detail=f"keep the change under {CHANGE_TEXT_MAX_CHARS} characters",
        )
    raw_kinds = body.get("kinds") or []
    if not isinstance(raw_kinds, list):
        raise HTTPException(status_code=422, detail="kinds must be a list")
    kinds: list[str] = []
    for kind in raw_kinds:
        kind = str(kind)
        if kind not in VALID_CHANGE_KINDS:
            raise HTTPException(
                status_code=422,
                detail=f"kind must be one of {list(VALID_CHANGE_KINDS)}",
            )
        if kind not in kinds:
            kinds.append(kind)
    apply = str(body.get("apply") or "").strip()
    if apply not in VALID_APPLY_MODES:
        raise HTTPException(
            status_code=422,
            detail=f"apply must be one of {list(VALID_APPLY_MODES)}",
        )
    return text, kinds, apply


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/{slug}/changes")
async def list_changes_route(request: Request) -> dict[str, Any]:
    """The history the Iterations tab groups: every directive (retired and
    proposed included) with its change metadata, and every run."""
    project, _role, _profiles, _principal = await projects_api._require_read(request)

    def _list_sync() -> dict:
        with projects_db.connect_closing() as conn:
            rows = projects_db.list_project_directives(
                conn, project.id, active_only=False
            )
            runs = projects_db.list_project_runs(conn, project.id, limit=200)
            deliveries = projects_db.get_output_deliveries(
                conn, project_id=project.id
            )
            run_cards = {r["id"]: projects_db.get_run_cards(conn, r["id"]) for r in runs}
        per_run: dict[str, int] = {}
        for d in deliveries:
            if d.get("run_id"):
                per_run[d["run_id"]] = per_run.get(d["run_id"], 0) + 1
        statuses: dict[str, Optional[str]] = {}
        try:
            with projects_api._board_conn(project) as bconn:
                for cards in run_cards.values():
                    for rc in cards:
                        task = kanban_db.get_task(bconn, rc["task_id"])
                        statuses[rc["task_id"]] = task.status if task else None
        except Exception:  # noqa: BLE001 — card counts are advisory
            logger.debug("changes history: board unavailable", exc_info=True)
        now = int(time.time())
        out_runs = []
        for r in runs:
            cards = run_cards.get(r["id"], [])
            row = dict(r)
            row["deliveries"] = per_run.get(r["id"], 0)
            if r.get("started_at"):
                end = r.get("ended_at") or now
                row["duration_seconds"] = max(0, int(end) - int(r["started_at"]))
            row["cards_total"] = len(cards)
            row["cards_done"] = sum(
                1 for rc in cards if statuses.get(rc["task_id"]) == "done"
            )
            out_runs.append(row)
        return {
            "changes": [_change_payload(r) for r in rows],
            "runs": out_runs,
            "applies_from": "next run",
        }

    return await asyncio.to_thread(_list_sync)


@router.post("/{slug}/changes")
async def create_change_route(request: Request) -> dict[str, Any]:
    """Record a requirement change and act on it in one request.

    ``apply``: ``now`` stops the open run (finished work kept) and drafts the
    revised plan; ``next`` drafts it and leaves the run alone; ``record``
    only saves the requirement. Judgement act (``member``+), like adding
    guidance, drafting a plan or stopping a run."""
    project, _role, profiles, principal = await projects_api._require_write(
        request, judgement=True
    )
    projects_api._refuse_if_archived(project, "changing its requirements")
    body = await _json_body(request)
    text, kinds, apply = _parse_change_body(body)
    key = _idempotency_key(request)

    def _create_sync() -> dict:
        with _CHANGES_LOCK, projects_db.connect_closing() as conn:
            if key:
                existing = _find_by_key(conn, project.id, key)
                if existing is not None:
                    meta = _parse_meta(existing.get("change_meta")) or {}
                    return {
                        "change": _change_payload(existing),
                        "draft": _draft_state(project.id)
                        if apply != "record"
                        else {"status": "idle"},
                        "stopped_run": meta.get("stopped_run"),
                        "replayed": True,
                    }
            outputs = _precheck_draft(conn, project) if apply != "record" else []
            cfg = projects_run.projects_runtime_config()
            try:
                did = projects_db.add_project_directive(
                    conn,
                    project_id=project.id,
                    kind="directive",
                    body=text,
                    author_user_id=principal.user_id,
                    max_active=cfg["guidance_max_directives"],
                )
            except ValueError as exc:
                status = 409 if "retire one first" in str(exc) else 422
                raise HTTPException(status_code=status, detail=str(exc))
            meta: dict[str, Any] = {"kinds": kinds, "apply": apply}
            if key:
                meta["key"] = key
            _write_meta(conn, did, meta)

            stopped_run: Optional[int] = None
            if apply == "now":
                for open_row in projects_db.list_open_project_runs(conn, project.id):
                    run = projects_db.get_project_run(
                        conn, project.id, open_row["run_no"]
                    )
                    if run is None:
                        continue
                    with projects_api._board_conn(project) as bconn:
                        try:
                            projects_run.stop_run(conn, bconn, project=project, run=run)
                        except ValueError:
                            continue
                    stopped_run = int(run["run_no"])
                if stopped_run is not None:
                    meta = _update_meta(conn, did, stopped_run=stopped_run)

            change = _get_directive(conn, project.id, did) or {"id": did}
            draft: dict = {"status": "idle"}
            if apply != "record":
                draft = _start_change_draft(
                    conn, project, profiles, change, kinds, principal.user_id,
                    outputs,
                )
            return {
                "change": _change_payload(change),
                "draft": draft,
                "stopped_run": stopped_run,
                "applies_from": "next run",
            }

    return await asyncio.to_thread(_create_sync)


@router.post("/{slug}/changes/{change_id}/draft")
async def redraft_change_route(request: Request, change_id: str) -> dict[str, Any]:
    """Draft the revised plan again for a recorded change (e.g. after the
    first draft failed)."""
    project, _role, profiles, principal = await projects_api._require_write(
        request, judgement=True
    )
    projects_api._refuse_if_archived(project, "drafting its plan")

    def _redraft_sync() -> dict:
        with _CHANGES_LOCK, projects_db.connect_closing() as conn:
            change = _get_directive(conn, project.id, change_id)
            meta = _parse_meta(change.get("change_meta")) if change else None
            if change is None or meta is None:
                raise HTTPException(status_code=404, detail="change not found")
            outputs = _precheck_draft(conn, project)
            draft = _start_change_draft(
                conn, project, profiles, change, list(meta.get("kinds") or []),
                principal.user_id, outputs,
            )
            return {"change": _change_payload(change), "draft": draft}

    return await asyncio.to_thread(_redraft_sync)


@router.post("/{slug}/changes/{change_id}/approve")
async def approve_change_route(request: Request, change_id: str) -> dict[str, Any]:
    """Activate the drafted plan and (by default) start the next run.

    Lead/admin plus a verified session, like activating a plan by hand.
    ``start: false`` saves the plan without running. A run that is still
    open is a 409 before anything changes. Approving again with the same
    revision answers with the first result."""
    project, _role, _profiles, principal = await projects_api._require_write(request)
    projects_api._refuse_if_archived(project, "starting the next iteration")
    subject = await projects_api._require_human(request, "approving a change")
    body = await _json_body(request)
    try:
        rev = int(body.get("rev"))
    except (TypeError, ValueError):
        raise HTTPException(status_code=422, detail="rev must be a plan revision number")
    start = bool(body.get("start", True))
    raw_supersedes = body.get("supersedes") or []
    if not isinstance(raw_supersedes, list):
        raise HTTPException(status_code=422, detail="supersedes must be a list")
    supersedes = [str(s) for s in raw_supersedes]

    def _approve_sync() -> dict:
        with _CHANGES_LOCK, projects_db.connect_closing() as conn:
            change = _get_directive(conn, project.id, change_id)
            meta = _parse_meta(change.get("change_meta")) if change else None
            if change is None or meta is None:
                raise HTTPException(status_code=404, detail="change not found")
            approved = meta.get("approved") or None
            if approved and int(approved.get("rev") or 0) == rev and (
                approved.get("run_no") is not None or not start
            ):
                run = None
                if approved.get("run_no") is not None:
                    run = projects_db.get_project_run(
                        conn, project.id, int(approved["run_no"])
                    )
                return {
                    "change": _change_payload(change),
                    "rev": rev,
                    "active": True,
                    "run": run,
                    "superseded": approved.get("superseded") or [],
                    "replayed": True,
                }
            if projects_db.get_playbook(conn, project.id, rev=rev) is None:
                raise HTTPException(
                    status_code=404, detail=f"playbook revision {rev} not found"
                )
            if start:
                open_runs = projects_db.list_open_project_runs(conn, project.id)
                if open_runs:
                    n = open_runs[0]["run_no"]
                    raise HTTPException(
                        status_code=409,
                        detail=(
                            f"Run {n} is still open. Let it finish or stop it, "
                            "then start the next iteration."
                        ),
                    )
            projects_db.activate_playbook_rev(
                conn, project.id, rev, note=f"approved with change {change_id}"
            )
            superseded: list[str] = list((approved or {}).get("superseded") or [])
            for sid in supersedes:
                if sid == change_id:
                    continue
                target = _get_directive(conn, project.id, sid)
                if target is None or not target["active"]:
                    continue
                if projects_db.retire_project_directive(conn, sid):
                    with write_txn(conn):
                        conn.execute(
                            "UPDATE project_directives SET superseded_by = ? "
                            "WHERE id = ?",
                            (change_id, sid),
                        )
                    superseded.append(sid)
            run = None
            if start:
                with projects_api._board_conn(project) as bconn:
                    try:
                        started = projects_run.start_run(
                            conn,
                            bconn,
                            project=project,
                            trigger="manual",
                            triggered_by=principal.user_id,
                            playbook_rev=rev,
                        )
                    except projects_db.RunAlreadyOpen as exc:
                        raise HTTPException(status_code=409, detail=str(exc))
                    except ValueError as exc:
                        raise HTTPException(status_code=409, detail=str(exc))
                run = started.get("run")
            _update_meta(
                conn,
                change_id,
                approved={
                    "rev": rev,
                    "at": int(time.time()),
                    "by": subject,
                    "started": start,
                    "run_no": run["run_no"] if run else None,
                    "superseded": superseded,
                },
            )
            change = _get_directive(conn, project.id, change_id) or change
            return {
                "change": _change_payload(change),
                "rev": rev,
                "active": True,
                "run": run,
                "superseded": superseded,
                "applies_from": "next run",
            }

    return await asyncio.to_thread(_approve_sync)
