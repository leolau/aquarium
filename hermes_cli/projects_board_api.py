"""The Projects board's human verbs and its context read (redesign: board).

Small, additive routes beside ``projects_api``'s card routes:

- ``GET  /{slug}/board/context`` — what the board alone cannot say: which
  run created each card, and whether the open run is stalled (the same
  ``_run_stalled`` derivation the run detail read uses), so the board's
  empty lanes can tell the truth ("Run 2 is stalled — see why").
- ``POST /{slug}/cards/approve`` — "Approve all N": several triage cards
  made ready in one request, each through the same column-move routing as
  ``PATCH /{slug}/cards/{id}`` (one request, one idempotency key, so a
  repeated click can never approve a card twice from the browser).
- ``POST /{slug}/cards/{task_id}/approvals`` — answer an approval a card's
  worker recorded (it had no human to prompt); releases the card once
  nothing else is pending.
- ``POST /{slug}/cards/{task_id}/unblock`` — blocked → ready with an
  optional reason, which lands on the card's comment thread first so the
  worker that picks the card up reads why it was released.

Every write is a judgement act (§10), gated exactly like the card PATCH.
"""

from __future__ import annotations

import asyncio
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request

from hermes_cli import kanban_db, kanban_view, projects_db
from hermes_cli.projects_api import (
    _board_conn,
    _move_card_sync,
    _refuse_if_archived,
    _require_read,
    _require_write,
    _run_blocked_tasks,
    _run_stalled,
)

router = APIRouter(prefix="/api/registry/projects")

_APPROVE_MAX = 100
_REASON_MAX_LEN = 2_000
_OPEN_RUN_STATUSES = ("running", "waiting")
_APPROVABLE = ("triage", "todo")


async def _json_object(request: Request) -> dict:
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="invalid JSON body")
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="expected a JSON object")
    return body


# ---------------------------------------------------------------------------
# GET /{slug}/board/context
# ---------------------------------------------------------------------------


@router.get("/{slug}/board/context")
async def board_context(request: Request) -> dict[str, Any]:
    """``{card_runs: {task_id: run_no}, open_run: {...} | null}``.

    ``card_runs`` names the run that *created* each caller-visible card
    (the earliest, should a card ever be linked to two). ``open_run`` is
    the newest running/waiting run with its card ids, the number of
    blocked tasks in its dependency tree and the server's ``stalled``
    verdict.
    """
    project, _role, _profiles, principal = await _require_read(request)

    def _sync() -> dict:
        with _board_conn(project) as bconn:
            visible = {
                t.id
                for t in kanban_db.list_tasks(
                    bconn, project_id=project.id, principal=principal
                )
            }
            with projects_db.connect_closing() as conn:
                rows = conn.execute(
                    "SELECT rc.task_id AS task_id, MIN(r.run_no) AS run_no "
                    "FROM project_run_cards rc "
                    "JOIN project_runs r ON r.id = rc.run_id "
                    "WHERE r.project_id = ? GROUP BY rc.task_id",
                    (project.id,),
                ).fetchall()
                open_runs = [
                    r
                    for r in projects_db.list_project_runs(conn, project.id)
                    if r.get("status") in _OPEN_RUN_STATUSES
                ]
                run = open_runs[0] if open_runs else None
                run_cards = (
                    projects_db.get_run_cards(conn, run["id"]) if run else []
                )
            card_runs = {
                r["task_id"]: int(r["run_no"])
                for r in rows
                if r["task_id"] in visible
            }
            open_run: Optional[dict] = None
            if run is not None:
                cards = []
                for rc in run_cards:
                    task = kanban_db.get_task(bconn, rc["task_id"])
                    cards.append(
                        {
                            "task_id": rc["task_id"],
                            "status": task.status if task else None,
                        }
                    )
                blocked = _run_blocked_tasks(bconn, cards)
                open_run = {
                    "run_no": run["run_no"],
                    "status": run["status"],
                    "started_at": run.get("started_at"),
                    "card_ids": [
                        c["task_id"] for c in cards if c["task_id"] in visible
                    ],
                    "blocked_tree_count": len(blocked),
                    "stalled": _run_stalled(run, cards, blocked),
                    "auto_approve": bool(run.get("auto_approve")),
                }
        return {"card_runs": card_runs, "open_run": open_run}

    return await asyncio.to_thread(_sync)


# ---------------------------------------------------------------------------
# POST /{slug}/cards/approve — Approve all N
# ---------------------------------------------------------------------------


@router.post("/{slug}/cards/approve")
async def approve_cards(request: Request) -> dict[str, Any]:
    """Make several triage/todo cards ready: ``{task_ids: [...]}``.

    Each card goes through ``_move_card_sync`` — the same routing the
    single-card PATCH uses — so a parent-gated card legitimately lands in
    ``todo``. One card refusing never undoes the others: the answer lists
    every card with ``ok``, its resulting ``card`` row, or the reason.
    """
    project, _role, _profiles, principal = await _require_write(
        request, judgement=True
    )
    _refuse_if_archived(project, "approving cards")
    body = await _json_object(request)
    raw = body.get("task_ids")
    if not isinstance(raw, list) or not raw:
        raise HTTPException(
            status_code=422, detail="task_ids must be a non-empty list"
        )
    task_ids: list[str] = []
    for item in raw:
        tid = str(item or "").strip()
        if tid and tid not in task_ids:
            task_ids.append(tid)
    if not task_ids:
        raise HTTPException(
            status_code=422, detail="task_ids must be a non-empty list"
        )
    if len(task_ids) > _APPROVE_MAX:
        raise HTTPException(
            status_code=422,
            detail=f"at most {_APPROVE_MAX} cards can be approved at once",
        )
    actor = f"user:{principal.user_id}"

    def _sync() -> list[dict]:
        results: list[dict] = []
        with _board_conn(project) as bconn:
            for tid in task_ids:
                task = kanban_db.get_task(bconn, tid)
                if task is None or getattr(task, "project_id", None) != project.id:
                    results.append(
                        {"task_id": tid, "ok": False, "error": "card not found"}
                    )
                    continue
                if task.status not in _APPROVABLE:
                    # Already past approval (another viewer, or a replay):
                    # not an error, and nothing is executed twice.
                    results.append(
                        {
                            "task_id": tid,
                            "ok": True,
                            "unchanged": True,
                            "card": kanban_view.task_dict(task),
                        }
                    )
                    continue
                try:
                    ok, reason = _move_card_sync(bconn, task, "ready", actor)
                except Exception as exc:  # noqa: BLE001 — one card never sinks the batch
                    ok, reason = False, str(exc) or "the card could not be approved"
                updated = kanban_db.get_task(bconn, tid)
                entry: dict[str, Any] = {"task_id": tid, "ok": bool(ok)}
                if updated is not None:
                    entry["card"] = kanban_view.task_dict(updated)
                if not ok:
                    entry["error"] = reason
                results.append(entry)
        return results

    results = await asyncio.to_thread(_sync)
    return {
        "results": results,
        "approved": sum(1 for r in results if r["ok"] and not r.get("unchanged")),
        "failed": sum(1 for r in results if not r["ok"]),
    }


# ---------------------------------------------------------------------------
# POST /{slug}/cards/{task_id}/unblock — with an optional reason
# ---------------------------------------------------------------------------


@router.post("/{slug}/cards/{task_id}/unblock")
async def unblock_card(request: Request, task_id: str) -> dict[str, Any]:
    """Blocked → ready (or todo while a parent is open), ``{reason?}``.

    The reason is posted to the card's comment thread *before* the move,
    so the worker the dispatcher spawns next reads it.
    """
    project, _role, _profiles, principal = await _require_write(
        request, judgement=True
    )
    _refuse_if_archived(project, "unblocking a card")
    body = await _json_object(request)
    reason = str(body.get("reason") or "").strip()
    if len(reason) > _REASON_MAX_LEN:
        raise HTTPException(
            status_code=422,
            detail=f"the reason is too long (max {_REASON_MAX_LEN} characters)",
        )
    actor = f"user:{principal.user_id}"

    def _sync() -> dict:
        with _board_conn(project) as bconn:
            task = kanban_db.get_task(bconn, task_id)
            if task is None or getattr(task, "project_id", None) != project.id:
                raise KeyError(task_id)
            if task.status != "blocked":
                raise ValueError("the card is not blocked")
            if reason:
                kanban_db.add_comment(bconn, task_id, actor, reason)
            if not kanban_db.unblock_task(bconn, task_id):
                raise ValueError("the card is not blocked")
            return kanban_view.task_dict(kanban_db.get_task(bconn, task_id))

    try:
        return await asyncio.to_thread(_sync)
    except KeyError:
        raise HTTPException(status_code=404, detail="card not found")
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


# ---------------------------------------------------------------------------
# POST /{slug}/cards/{task_id}/approvals
# ---------------------------------------------------------------------------


@router.post("/{slug}/cards/{task_id}/approvals")
async def decide_card_approval(request: Request, task_id: str) -> dict[str, Any]:
    """Answer an approval a card's worker asked for, ``{key, decision}``.

    ``decision`` is ``approve`` or ``deny``. The answer lands on the card's
    comment thread, and once nothing else is pending on a blocked card it
    is released, so the next worker either makes the approved call or
    reads that it was denied.
    """
    project, _role, _profiles, principal = await _require_write(
        request, judgement=True
    )
    _refuse_if_archived(project, "answering a card's approval")
    body = await _json_object(request)
    key = str(body.get("key") or "").strip()
    decision = str(body.get("decision") or "").strip()
    if not key:
        raise HTTPException(status_code=422, detail="key is required")
    if decision not in ("approve", "deny"):
        raise HTTPException(
            status_code=422, detail="decision must be 'approve' or 'deny'"
        )
    approve = decision == "approve"
    actor = f"user:{principal.user_id}"

    def _sync() -> dict:
        with _board_conn(project) as bconn:
            task = kanban_db.get_task(bconn, task_id)
            if task is None or task.project_id != project.id:
                raise KeyError(task_id)
            label = kanban_db.decide_task_approval(
                bconn, task_id, key, approve=approve, actor=actor
            )
            if label is None:
                raise ValueError("nothing is waiting for that approval")
            kanban_db.add_comment(
                bconn,
                task_id,
                actor,
                f"Approved for this card: {label}. The call will go through now."
                if approve
                else f"Denied for this card: {label}. Do not use it or get the "
                "same effect another way; finish without it, or block the card "
                "and say what cannot be done without it.",
            )
            pending = kanban_db.list_task_approvals(bconn, [task_id]).get(task_id, [])
            if task.status == "blocked" and not pending:
                kanban_db.unblock_task(bconn, task_id)
            refreshed = kanban_db.get_task(bconn, task_id)
            if refreshed is None:
                raise KeyError(task_id)
            out = kanban_view.task_dict(refreshed)
            out["pending_approvals"] = pending
            return out

    try:
        return await asyncio.to_thread(_sync)
    except KeyError:
        raise HTTPException(status_code=404, detail="card not found")
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
