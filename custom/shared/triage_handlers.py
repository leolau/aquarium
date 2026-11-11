#!/usr/bin/env python3
"""
Triage Handler Registry

A dispatch table that maps JSON response field names to handler functions.
Each triage agent (WhatsApp, email, calendar) calls process_result() with the
LLM's JSON response, and the dispatcher routes each field to its registered
handler.

Handlers are channel-aware: the batch dict carries a `_channel` key
('whatsapp', 'email', 'calendar') that determines which SQLite table and
columns to use.

Adding a new output type (e.g., 'deadlines') requires:
1. Adding the field to response-schema.md (no deploy — LLM starts returning it)
2. Adding a @register('deadlines') handler here (deploy required)
Step 1 alone is safe: the dispatcher logs "no handler for deadlines — ignoring."
"""

import json
import uuid
from datetime import datetime, timezone


_HANDLERS = {}


def register(key):
    """Decorator to register a handler for a JSON response field."""
    def deco(fn):
        _HANDLERS[key] = fn
        return fn
    return deco


# ---------------------------------------------------------------------------
# Shared handler — memory_facts (all channels)
# ---------------------------------------------------------------------------

@register('memory_facts')
def _handle_memory_facts(facts, batch, db):
    """Push facts to Hermes long-term memory via memory_bridge."""
    if not facts or not isinstance(facts, list):
        return
    try:
        from shared.memory_bridge import remember_facts
        channel = batch.get('_channel', 'unknown')
        sender = (batch.get('sender_phone') or batch.get('sender')
                  or batch.get('organizer_email', ''))
        remembered = remember_facts(facts, source=channel, sender=sender)
        if remembered:
            print(f"[triage] Remembered {remembered} fact(s) to long-term memory")
    except ImportError:
        pass  # memory_bridge not available
    except Exception as e:
        print(f"[triage] Memory bridge error: {e}")


# ---------------------------------------------------------------------------
# WhatsApp handlers
# ---------------------------------------------------------------------------

@register('tasks')
def _handle_tasks(tasks, batch, db):
    """Write tasks to the appropriate SQLite table based on channel."""
    if not tasks:
        return
    channel = batch.get('_channel', 'whatsapp')
    now = datetime.now(timezone.utc).isoformat()

    if channel == 'whatsapp':
        source_phone = batch.get('source_phone', '')
        msg_id = batch['messages'][0]['msg_id'] if batch.get('messages') else ''
        for task in tasks:
            try:
                db.execute(
                    """INSERT INTO wa_tasks (id, source_phone, source_msg_id, description, due_date, status, priority, created_at)
                       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)""",
                    (str(uuid.uuid4()), source_phone, msg_id,
                     task.get('description', ''), task.get('due_date'),
                     task.get('priority', 'medium'), now)
                )
            except Exception as e:
                print(f"[triage] Error inserting task: {e}")

    elif channel == 'email':
        account_id = batch.get('account_id', '')
        first_email_id = batch['emails'][0]['id'] if batch.get('emails') else None
        for task in tasks:
            try:
                db.execute(
                    """INSERT INTO email_tasks (id, account_id, source_email_id, description, due_date, status, priority, created_at)
                       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)""",
                    (str(uuid.uuid4()), account_id, first_email_id,
                     task.get('description', ''), task.get('due_date'),
                     task.get('priority', 'medium'), now)
                )
            except Exception as e:
                print(f"[triage] Error inserting task: {e}")


@register('todos')
def _handle_todos(todos, batch, db):
    """Stage what this batch implies the user may want to do about it.

    Distinct from `tasks` above, and deliberately so: `tasks` is the pipeline's
    own extraction, it stays in SQLite, and it fires for almost every batch.
    A to-do is a judgement — this is worth the user's attention — and it lands
    in the shared store behind the /todos page. Most arrive `staged` and say
    nothing; only `notify` promotes one to `open`, where step 3 announces it.

    Best-effort by construction. The SQLite writes above already happened, so
    a registry outage costs a nudge, never the pipeline's record.
    """
    if not todos or not isinstance(todos, list):
        return
    try:
        from shared.todo_registration import register_todo, select_candidates
    except ImportError:
        return

    channel = batch.get('_channel', 'whatsapp')
    arrivals = _triaged_arrivals(batch)
    surface, account_id, external_id = (
        arrivals[0] if arrivals else (channel, '', '')
    )
    summary = batch.get('summary', '')

    for candidate in select_candidates(
        [t for t in todos if isinstance(t, dict)]
    ):
        title = (candidate.get('title') or candidate.get('description')
                 or '').strip()
        if not title:
            continue
        detail = candidate.get('detail') or candidate.get('reason') or summary
        recorded = register_todo(
            title=title,
            description=detail or '',
            priority=candidate.get('priority', 'medium'),
            due_date=candidate.get('due_date'),
            notify=bool(candidate.get('notify')),
            surface=surface,
            account_id=account_id,
            external_id=external_id,
            actor=f'skill:{channel}-triage',
        )
        if recorded and arrivals:
            # Read by stamp_inbox_importance: a to-do linked to an arrival is
            # one of the reasons it shows in the landing Incomings tab.
            batch.setdefault('_todo_arrivals', []).append(
                (surface, account_id, external_id,
                 candidate.get('priority', 'medium'))
            )
        if recorded and recorded.get('created'):
            print(f"[triage] Staged to-do ({recorded['stage']}): {title}")


@register('notes')
def _handle_notes(notes, batch, db):
    """Write notes to the appropriate SQLite table based on channel."""
    if not notes:
        return
    channel = batch.get('_channel', 'whatsapp')
    now = datetime.now(timezone.utc).isoformat()

    if channel == 'whatsapp':
        source_phone = batch.get('source_phone', '')
        msg_id = batch['messages'][0]['msg_id'] if batch.get('messages') else ''
        for note in notes:
            try:
                db.execute(
                    """INSERT INTO wa_notes (id, source_phone, source_msg_id, content, created_at)
                       VALUES (?, ?, ?, ?, ?)""",
                    (str(uuid.uuid4()), source_phone, msg_id,
                     note.get('content', ''), now)
                )
            except Exception as e:
                print(f"[triage] Error inserting note: {e}")

    elif channel == 'email':
        account_id = batch.get('account_id', '')
        first_email_id = batch['emails'][0]['id'] if batch.get('emails') else None
        for note in notes:
            try:
                db.execute(
                    """INSERT INTO email_notes (id, account_id, source_email_id, content, created_at)
                       VALUES (?, ?, ?, ?, ?)""",
                    (str(uuid.uuid4()), account_id, first_email_id,
                     note.get('content', ''), now)
                )
            except Exception as e:
                print(f"[triage] Error inserting note: {e}")


@register('escalate')
def _handle_escalate(should_escalate, batch, db):
    """Create an escalation record if flagged."""
    if not should_escalate:
        return
    channel = batch.get('_channel', 'whatsapp')
    now = datetime.now(timezone.utc).isoformat()

    if channel == 'whatsapp':
        source_phone = batch.get('source_phone', '')
        msg_id = batch['messages'][0]['msg_id'] if batch.get('messages') else ''
        sender_phone = batch.get('sender_phone', '')
        try:
            db.execute(
                """INSERT INTO escalations (id, source_phone, source_msg_id, sender_phone, reason, summary, priority, status, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)""",
                (str(uuid.uuid4()), source_phone, msg_id, sender_phone,
                 batch.get('escalation_reason', 'unknown'),
                 batch.get('summary', ''),
                 batch.get('escalation_priority', 'medium'), now)
            )
        except Exception as e:
            print(f"[triage] Error inserting escalation: {e}")

    elif channel == 'email':
        account_id = batch.get('account_id', '')
        first_email_id = batch['emails'][0]['id'] if batch.get('emails') else None
        sender_email = batch.get('sender', '')
        sender_name = batch.get('sender_name', '')

        # Look up contact_id
        contact_id = None
        try:
            handle = db.execute(
                "SELECT contact_id FROM contact_handles WHERE handle_type = 'email' AND handle_value = ?",
                (sender_email,)
            ).fetchone()
            if handle:
                contact_id = handle['contact_id']
        except Exception:
            pass

        try:
            db.execute(
                """INSERT INTO escalations (id, source_phone, source_msg_id, sender_phone,
                   reason, summary, priority, status, created_at,
                   channel, sender_email, sender_name, contact_id)
                   VALUES (?, ?, ?, NULL, ?, ?, ?, 'pending', ?, 'email', ?, ?, ?)""",
                (str(uuid.uuid4()), account_id, first_email_id,
                 batch.get('escalation_reason', 'unknown'),
                 batch.get('summary', ''),
                 batch.get('escalation_priority', 'medium'), now,
                 sender_email, sender_name, contact_id)
            )
        except Exception as e:
            print(f"[triage] Error inserting escalation: {e}")


# ---------------------------------------------------------------------------
# Calendar handlers
# ---------------------------------------------------------------------------

@register('importance')
def _handle_importance(importance, batch, db):
    """Update the calendar event's importance and triage status."""
    event_id = batch.get('event_id', '')
    if not event_id:
        return
    now = datetime.now(timezone.utc).isoformat()
    try:
        db.execute(
            "UPDATE calendar_events SET importance = ?, triaged = 1, updated_at = ? WHERE id = ?",
            (importance, now, event_id)
        )
    except Exception as e:
        print(f"[calendar-triage] Error updating importance: {e}")


@register('importance_reason')
def _handle_importance_reason(reason, batch, db):
    """Store the importance classification reason."""
    event_id = batch.get('event_id', '')
    if not event_id:
        return
    now = datetime.now(timezone.utc).isoformat()
    try:
        db.execute(
            "UPDATE calendar_events SET importance_reason = ?, updated_at = ? WHERE id = ?",
            (reason, now, event_id)
        )
    except Exception as e:
        print(f"[calendar-triage] Error updating importance_reason: {e}")


@register('prep_notes')
def _handle_prep_notes(prep_notes, batch, db):
    """Store preparation notes for the event."""
    event_id = batch.get('event_id', '')
    if not event_id:
        return
    now = datetime.now(timezone.utc).isoformat()
    try:
        db.execute(
            "UPDATE calendar_events SET prep_notes = ?, updated_at = ? WHERE id = ?",
            (prep_notes, now, event_id)
        )
    except Exception as e:
        print(f"[calendar-triage] Error updating prep_notes: {e}")


# ---------------------------------------------------------------------------
# Inbox projection
# ---------------------------------------------------------------------------

def _triage_importance(result):
    """The one verdict the Inbox shows, out of three channels' vocabularies.

    An escalation outranks anything else: the escalation pusher already
    decided a human must look, and the Inbox filter should agree with the
    Telegram alert rather than describe the same message as 'informational'.
    """
    if result.get('escalate'):
        return result.get('escalation_priority') or 'urgent'
    return result.get('importance') or result.get('classification') or ''


def _triaged_arrivals(batch):
    """`(surface, account_id, external_id)` for everything this verdict covers.

    The ids are the channel's own — the same ones the pollers registered with
    — because triage runs in a separate process that never saw the registry's
    row ids.
    """
    channel = batch.get('_channel', 'whatsapp')
    if channel == 'whatsapp':
        account = batch.get('source_phone', '')
        return [
            ('whatsapp', account, m['msg_id'])
            for m in batch.get('messages', [])
            if m.get('msg_id')
        ]
    if channel == 'email':
        account = batch.get('account_id', '')
        return [
            ('email', account, em['message_id'])
            for em in batch.get('emails', [])
            if em.get('message_id')
        ]
    if channel == 'calendar' and batch.get('google_event_id'):
        return [
            ('calendar', batch.get('account_id', ''), batch['google_event_id'])
        ]
    return []


_ATTENTION_PRIORITY = {
    'urgent': 'urgent', 'critical': 'urgent', 'high': 'high',
    'medium': 'medium', 'normal': 'medium', 'low': 'low',
}
_ATTENTION_PRIORITY_RANK = {'urgent': 4, 'high': 3, 'medium': 2, 'low': 1}


def _attention_priority(value, default=None):
    return _ATTENTION_PRIORITY.get(str(value or '').strip().lower(), default)


def _triage_attention(result, batch, arrival):
    """`(reason, priority)` when this verdict means the user must look, else None.

    One rule for the landing Incomings tab: escalated, a critical calendar
    event, or a to-do created for the arrival. Everything else (informational
    chatter, newsletters) is in the Inbox but does not ask for the user. The
    registry keeps the highest verdict, so returning the strongest one here
    is enough.
    """
    if result.get('escalate'):
        return 'escalated', _attention_priority(
            result.get('escalation_priority'), 'urgent')
    if (batch.get('_channel') == 'calendar'
            and str(result.get('importance') or '').lower() == 'critical'):
        return 'critical_event', 'urgent'
    priorities = [
        _attention_priority(priority, 'medium')
        for surface, account_id, external_id, priority
        in batch.get('_todo_arrivals') or []
        if (surface, account_id, external_id) == arrival
    ]
    if priorities:
        return 'todo', max(
            priorities, key=lambda p: _ATTENTION_PRIORITY_RANK.get(p, 0))
    return None


def stamp_inbox_importance(result, batch):
    """Mirror the triage verdict onto the arrivals in the shared registry.

    Best-effort and never fatal: the SQLite triage tables remain the pipeline's
    source of truth, and an unstamped row still shows in the Inbox — just
    without the urgency filter finding it.
    """
    importance = _triage_importance(result)
    arrivals = _triaged_arrivals(batch)
    attention = {arrival: _triage_attention(result, batch, arrival)
                 for arrival in arrivals}
    if not importance and not any(attention.values()):
        return
    try:
        from shared.inbound_registration import mark_importance
    except ImportError:
        return
    for arrival in arrivals:
        surface, account_id, external_id = arrival
        reason, priority = attention[arrival] or (None, None)
        if not importance and reason is None:
            continue
        mark_importance(
            surface=surface,
            external_id=external_id,
            account_id=account_id,
            importance=importance,
            attention_reason=reason,
            attention_priority=priority,
        )


# ---------------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------------

def process_result(result, batch, db):
    """Generic dispatcher — handles whatever fields the LLM returned.

    Iterates over every key in the JSON response and calls the registered
    handler. Unregistered fields are logged and safely ignored.

    The batch dict must contain '_channel' ('whatsapp', 'email', 'calendar')
    so handlers know which SQLite tables and columns to use.

    The result dict is also merged into the batch dict so escalation handlers
    can access escalation_reason, escalation_priority, and summary from the
    LLM response.
    """
    # Merge result fields into batch so escalation handler can access them
    for key, value in result.items():
        batch[key] = value

    for key, value in result.items():
        handler = _HANDLERS.get(key)
        if handler:
            try:
                handler(value, batch, db)
            except Exception as e:
                print(f"[triage] Handler error for field '{key}': {e}")
        else:
            # Silently ignore fields without handlers (e.g., classification, summary)
            pass

    # After the SQLite writes, so a registry blip cannot cost the pipeline its
    # own record of the verdict.
    try:
        stamp_inbox_importance(result, batch)
    except Exception as e:
        print(f"[triage] Could not stamp inbox importance: {e}")
