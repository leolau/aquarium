"""The work launcher: a to-do that needs output, not just attention.

Three callers share this module:

* ``POST /todos/{id}/start {session: true}`` — the user's "Work on this",
* the triage ``work_request`` handler — a skill's ``auto_start`` verdict,
* the approval-answer path — free-text feedback that asks for a revision.

All three need the same arc and only this module owns it: build the seed
prompt from the to-do and its source arrival, point the session at a
per-to-do draft directory, spawn detached, and when the session returns,
land the result — draft files captured into ``work_result``, the to-do
moved to ``review``, a "draft ready" notification, the IM/push courtesy,
and — when a reply draft exists — the send proposal itself.

The draft convention is deliberately files-on-disk:

    $HERMES_HOME/drafts/todo_<id>/DRAFT.md   — the deliverable
    $HERMES_HOME/drafts/todo_<id>/REPLY.txt  — the ready-to-send reply

Files are the right artifact because the user edits them (PATCH writes
them back) and because the next revision session inherits them for free —
a relaunch with feedback finds the prior draft already in its workdir.
"""

from __future__ import annotations

import asyncio
import contextvars
import logging
import os
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Optional

log = logging.getLogger(__name__)

#: Draft convention — filenames the session prompt names and the API reads.
DRAFT_FILENAME = "DRAFT.md"
REPLY_FILENAME = "REPLY.txt"

#: Caps for what lands in ``work_result`` — full files stay on disk; the
#: column carries enough for a list row and a notification body.
MAX_DRAFT_CHARS = 50_000
MAX_SUMMARY_CHARS = 2_000


def draft_dir_for(todo_id: str) -> Path:
    """The per-to-do drafts directory under HERMES_HOME."""
    from hermes_constants import get_hermes_home

    return Path(get_hermes_home()) / "drafts" / f"todo_{todo_id}"


def _shared_draft_perms(draft_dir: Path) -> None:
    """Draft dirs are touched by two service users.

    The triage service / dashboard (``hermes``) creates them, the work
    session's tools (``terminal.run_as``, ``hermes-tools`` on the box) write
    ``DRAFT.md`` / ``REPLY.txt``, and the draft PATCH route (``hermes``
    again) edits them afterwards. Both dirs go to the terminal user's group
    (``hermes`` is in it), never to everyone on the box: ``drafts/`` is
    setgid + sticky so a per-to-do dir inherits the group and nobody removes
    another's, the leaf is setgid so a later PATCH or revision session can
    replace files it does not own. No ``run_as`` means one user, nothing to
    share. Best-effort: a dir someone else owns keeps its mode.
    """
    from tools import terminal_user

    user = terminal_user.configured_user()
    if not user:
        return
    for path, mode in ((draft_dir.parent, 0o3770), (draft_dir, 0o2770)):
        try:
            terminal_user.share_with(user, str(path), mode)
        except (OSError, KeyError):
            pass


def prepare_draft_dir(draft_dir: Path) -> Path:
    """Create a drafts dir the whole service split can share."""
    for path in (draft_dir.parent, draft_dir):
        if path.is_symlink():
            # The tree is writable by the terminal user: a planted link would
            # make the dashboard user hand its own folder to that group.
            raise OSError(f"draft folder {path} is a symlink; refusing to use it")
    draft_dir.mkdir(parents=True, exist_ok=True)
    _shared_draft_perms(draft_dir)
    return draft_dir


def write_draft_file(path: Path, text: str) -> None:
    """Write a draft file, replacing whatever is there.

    The existing file may be owned by a different service user than the
    caller (session tools run as ``hermes-tools``, the draft API as
    ``hermes``): opening it for write needs ownership, but rename only
    needs a writable directory — which the shared perms provide.
    """
    # mkstemp creates the temp file exclusively (O_EXCL), so a link planted
    # in this shared folder is never followed; os.replace swaps the name.
    fd, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.replace(tmp, path)
    finally:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass


def _work_instructions(draft_dir: Path, *, revision: bool) -> str:
    prior = (
        " A previous draft may already be in this directory — read it and "
        "revise it rather than starting over."
        if revision
        else ""
    )
    return (
        "\n---\n"
        "## Deliverable\n"
        f"When the work is done, write it to files in `{draft_dir}`:"
        + prior
        + f"""

- `{DRAFT_FILENAME}` — the deliverable itself (the quotation, the brief, the
  analysis). Markdown.
- `{REPLY_FILENAME}` — the ready-to-send reply to whoever sent the source
  message, in their language and an appropriate tone, referencing the
  deliverable. Plain text, no headers, nothing you would not send as-is.

Write both even when unsure — a draft the user edits beats no draft. Do not
send anything: the user reviews first and approves the reply themselves."""
    )


def build_work_prompt(
    todo,
    arrival: Optional[Mapping[str, Any]],
    *,
    draft_dir: Path,
    extra_context: Optional[str] = None,
    revision: bool = False,
) -> str:
    """The seed prompt for a to-do work session.

    Same shape the ``/start`` route always used — title, description, the
    arrival's own words — plus the deliverable convention and, on a
    feedback relaunch, the user's notes.
    """
    parts = [f"# {todo.title}"]
    if todo.description:
        parts.append(todo.description)
    if todo.source_note:
        parts.append(f"(From {todo.source_note})")
    if arrival and arrival.get("body"):
        parts.append(f"\n---\nSource message:\n{arrival['body'][:2000]}")
    if extra_context:
        label = "Review feedback — apply this" if revision else "Additional context"
        parts.append(f"\n---\n{label}:\n{extra_context[:4000]}")
    parts.append(_work_instructions(draft_dir, revision=revision))
    return "\n\n".join(parts)


def collect_work_result(
    draft_dir: Path,
    *,
    session_id: str,
    result: Any,
    error: Optional[str] = None,
) -> dict[str, Any]:
    """Snapshot what the session left in ``draft_dir`` onto the to-do row."""
    files = []
    draft_text = ""
    reply_text = ""
    if draft_dir.is_dir():
        for path in sorted(draft_dir.iterdir()):
            if path.is_file():
                files.append({"name": path.name, "path": str(path), "bytes": path.stat().st_size})
        for name, cap in ((DRAFT_FILENAME, MAX_DRAFT_CHARS), (REPLY_FILENAME, MAX_DRAFT_CHARS)):
            path = draft_dir / name
            if path.is_file():
                try:
                    text = path.read_text(encoding="utf-8", errors="replace")
                except OSError:
                    continue
                if name == DRAFT_FILENAME:
                    draft_text = text[:cap]
                else:
                    reply_text = text[:cap]
    return {
        "session_id": session_id,
        "draft_dir": str(draft_dir),
        "files": files,
        "draft_text": draft_text,
        "reply_text": reply_text,
        "summary": str(result)[:MAX_SUMMARY_CHARS] if result else "",
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "error": error,
    }


async def _load_arrival(store, principal, todo) -> Optional[dict[str, Any]]:
    """The registry row behind the to-do, when it has one (C4 routing)."""
    if not todo.source_ref:
        return None
    try:
        from hermes_cli.inbound_registry import default_registry

        item = await default_registry().get(principal, str(todo.source_ref))
        return item.as_dict() if item is not None else None
    except Exception as exc:  # noqa: BLE001 - routing is best-effort
        log.debug("todo_work: source arrival unavailable (%s)", exc)
        return None


async def _notify_draft_ready(
    store,
    principal,
    todo,
    work_result: Mapping[str, Any],
) -> Optional[str]:
    """Raise the 'draft ready' item + push; returns the notification id."""
    from hermes_cli.human_comms import NotificationStore

    notifications = NotificationStore(store._store)
    title = f"Draft ready for review: {todo.title[:180]}"
    produced = [f["name"] for f in work_result.get("files", [])]
    body = (work_result.get("summary") or "").strip()
    if produced:
        body = (f"Produced: {', '.join(produced)}.\n\n" + body).strip()
    result = await notifications.create(
        kind="proactive_ask",
        target_user_id=todo.owner_user_id,
        title=title,
        body=body[:2000],
        visibility=todo.visibility,
        dedupe_key=f"todo-draft:{todo.id}:{work_result.get('session_id', '')}",
    )
    notification = result.notification

    # Web push — the courtesy that means the app does not have to be open.
    # Same seam projects_run._push_approval uses; absence is never an error.
    try:
        from plugins.platforms.app.push import send_push

        await send_push(
            f"todo-draft:{todo.id}",
            title=title,
            body=body[:300],
            url=f"/todos/{todo.id}",
        )
    except Exception:
        pass

    # IM push — the channel is config, not a hardcoded Telegram client, so
    # the same code reaches WhatsApp, Telegram, or any platform
    # send_message_tool speaks.
    try:
        from hermes_cli.config import load_config

        im_target = ((load_config() or {}).get("todos") or {}).get("im_target", "")
        if str(im_target).strip():
            from tools.send_message_tool import send_message_tool

            send_message_tool(
                {
                    "action": "send",
                    "target": str(im_target).strip(),
                    "message": f"{title}\n\n{body[:1500]}",
                }
            )
    except Exception as exc:  # noqa: BLE001 - the row already exists
        log.debug("todo_work: IM push for %s failed (%s)", todo.id, exc)

    return notification.id


async def _propose_reply(
    store,
    principal,
    todo,
    work_result: Mapping[str, Any],
    arrival: Optional[Mapping[str, Any]],
) -> Optional[dict[str, Any]]:
    """Turn REPLY.txt into the irreversible send approval (C4 routing).

    Proposing is not sending: the approval still waits for the user, and
    editing the reply in the draft panel amends the pending approval's body
    so what they approve is what leaves.
    """
    reply_text = (work_result.get("reply_text") or "").strip()
    if not reply_text:
        return None
    try:
        from hermes_cli.human_comms import NotificationStore
        from hermes_cli.todo_outbound import OutboundError, parse_action, propose

        action = parse_action(
            {"body": reply_text},
            arrival=arrival,
        )
        notifications = NotificationStore(store._store)
        proposal = await propose(store, notifications, principal, todo, action)
        return proposal.as_dict()
    except OutboundError as exc:
        log.debug("todo_work: reply draft could not be routed (%s)", exc)
    except Exception as exc:  # noqa: BLE001 - the draft itself is safe
        log.debug("todo_work: reply proposal failed (%s)", exc)
    return None


async def finalize_todo_work(
    store,
    principal,
    todo_id: str,
    *,
    session_id: str,
    draft_dir: Path,
    result: Any,
    error: Optional[str],
    actor: str,
) -> dict[str, Any]:
    """Land a finished session: capture, stage, notify, propose.

    Best-effort per step — the draft files on disk are the durable artifact;
    a notification or stage failure must not pretend the work did not happen.
    """
    work_result = collect_work_result(
        draft_dir, session_id=session_id, result=result, error=error
    )
    try:
        await store.set_work_result(principal, todo_id, work_result, actor=actor)
    except Exception as exc:  # noqa: BLE001
        log.warning("todo_work: could not persist work_result for %s (%s)", todo_id, exc)

    todo = None
    try:
        if error:
            await store.record_outbound(
                principal, todo_id, event="work_failed", channel="work", actor=actor
            )
            todo = await store.set_stage(
                principal, todo_id, "open",
                outcome=f"Work session failed: {str(error)[:200]}",
                actor=actor,
            )
        else:
            await store.record_outbound(
                principal, todo_id, event="draft_ready", channel="work", actor=actor
            )
            todo = await store.set_stage(principal, todo_id, "review", actor=actor)
    except Exception as exc:  # noqa: BLE001
        log.warning("todo_work: stage/audit for %s failed (%s)", todo_id, exc)
        try:
            todo = await store.get(principal, todo_id)
        except Exception:
            todo = None

    if error or todo is None:
        return {"work_result": work_result, "notification_id": None, "proposal": None}

    notification_id = None
    try:
        notification_id = await _notify_draft_ready(store, principal, todo, work_result)
    except Exception as exc:  # noqa: BLE001
        log.warning("todo_work: draft-ready notification for %s failed (%s)", todo_id, exc)

    proposal = None
    try:
        arrival = await _load_arrival(store, principal, todo)
        proposal = await _propose_reply(store, principal, todo, work_result, arrival)
    except Exception as exc:  # noqa: BLE001
        log.debug("todo_work: proposal step for %s failed (%s)", todo_id, exc)

    return {
        "work_result": work_result,
        "notification_id": notification_id,
        "proposal": proposal,
    }


def launch_todo_work(
    store,
    principal,
    todo,
    *,
    actor: str,
    session_id: Optional[str] = None,
    arrival: Optional[Mapping[str, Any]] = None,
    extra_context: Optional[str] = None,
    revision: bool = False,
) -> str:
    """Spawn the work session detached; return its session id.

    The caller has already moved the to-do to ``working``. The thread owns
    the rest: run, capture, review-stage, notify, propose.
    """
    draft_dir = draft_dir_for(todo.id)
    try:
        prepare_draft_dir(draft_dir)
    except OSError as exc:
        log.warning("todo_work: could not create %s (%s)", draft_dir, exc)

    prompt = build_work_prompt(
        todo,
        arrival,
        draft_dir=draft_dir,
        extra_context=extra_context,
        revision=revision,
    )
    _session_id = session_id or (
        f"todo_{todo.id}_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}"
    )
    _ctx = contextvars.copy_context()

    from hermes_constants import get_hermes_home

    _profile_home = str(get_hermes_home())
    _todo_id = todo.id

    def _spawn() -> None:
        from agent.seeded_session import spawn_seeded_session

        outcome = spawn_seeded_session(
            prompt,
            origin="todo",
            session_id=_session_id,
            profile_home=_profile_home,
            skip_memory=False,  # a to-do session is the user's work
            workdir=str(draft_dir),
            context=_ctx,
            internal_user_id=principal.user_id,
            internal_user_role=getattr(principal, "role", None),
        )
        if outcome.error:
            log.warning(
                "todo_work: session %s failed (%s)", _session_id, outcome.error
            )
        try:
            asyncio.run(
                store.record_session(
                    principal,
                    _todo_id,
                    session_id=_session_id,
                    actor=actor,
                )
            )
        except Exception as exc:  # noqa: BLE001
            log.debug(
                "todo_work: session pointer for %s failed (%s)", _session_id, exc
            )
        try:
            asyncio.run(
                finalize_todo_work(
                    store,
                    principal,
                    _todo_id,
                    session_id=_session_id,
                    draft_dir=draft_dir,
                    result=outcome.result,
                    error=outcome.error,
                    actor=actor,
                )
            )
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "todo_work: finalize for %s failed (%s)", _session_id, exc
            )

    threading.Thread(target=_spawn, daemon=True).start()
    return _session_id
