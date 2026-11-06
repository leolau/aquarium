"""FG-26 — audit trail for identity administration (C5 change + C8 span).

Every act of the Users console that changes who exists, what they may do, or
whether they can log in is recorded twice, because the two ledgers answer
different questions: the C5 ``changes`` log is the durable "what was done to
this user, by whom" record the console's activity view reads, and the C8
``interactions`` span puts the same act on the operational timeline next to the
requests around it.

Two rules this module exists to enforce in one place rather than at each call
site:

* **No raw invitation token, ever.** A token in an audit payload would outlive
  the 5-minute window and turn the audit trail into a credential store, so
  payloads are filtered (:func:`_safe_payload`) rather than trusted.
* **Auditing never fails the operation.** The user was created; refusing to
  report success because the ledger was unreachable would leave the caller
  believing nothing happened. Failures are logged and swallowed.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Mapping, Sequence

if TYPE_CHECKING:
    from hermes_cli.access import Principal
    from hermes_cli.datastore import SupabaseAppStore

logger = logging.getLogger(__name__)

#: ``target_ref`` prefix for identity events, so the activity view can select
#: them out of the shared change log without a second table.
TARGET_PREFIX = "user:"

#: Payload keys never written to an audit row, whatever a caller passes.
_FORBIDDEN_KEYS = frozenset({"token", "invitation_token", "password", "secret"})


def target_ref(user_id: str) -> str:
    """Return the C5 ``target_ref`` naming a user administration event."""
    return f"{TARGET_PREFIX}{user_id}"


async def record_identity_event(
    *,
    store: "SupabaseAppStore",
    actor_user_id: str,
    action: str,
    user_id: str,
    payload: Mapping[str, object] | None = None,
    config: Mapping[str, object] | None = None,
    acting_profile: str | None = None,
    target_profile: str | None = None,
) -> None:
    """Record one identity administration event in C5 and C8.

    ``action`` is a stable verb (``user.create``, ``user.role``,
    ``user.invitation``, ``user.activate``, ``user.delete``, …). Best-effort by
    design: see the module docstring.

    ``acting_profile`` (the profile the serving process acts as) and
    ``target_profile`` (the profile whose ``store`` this event lands in) are
    recorded when given, so a cross-profile act names both ends. They are
    written after the caller's payload so a caller cannot misattribute them.
    """
    # ``action`` and ``user_id`` travel *inside* the payload as well as in the
    # approval row, because ``ChangeEvent`` exposes the payload but not the
    # approval's action/target — and the activity view reads change events.
    safe = {
        "action": action,
        "user_id": user_id,
        **_safe_payload(payload),
    }
    if acting_profile is not None:
        safe["acting_profile"] = acting_profile
    if target_profile is not None:
        safe["target_profile"] = target_profile
    try:
        await _record_change(
            store=store,
            actor_user_id=actor_user_id,
            action=action,
            user_id=user_id,
            payload=safe,
            config=config,
        )
    except Exception as exc:  # noqa: BLE001 — auditing must not fail the op
        logger.warning("identity audit: C5 record failed for %s: %s", action, exc)
    try:
        await _record_span(
            store=store,
            actor_user_id=actor_user_id,
            action=action,
            user_id=user_id,
            payload=safe,
            config=config,
        )
    except Exception as exc:  # noqa: BLE001 — same
        logger.warning("identity audit: C8 span failed for %s: %s", action, exc)


async def list_identity_events(
    *,
    store: "SupabaseAppStore",
    principal: "Principal",
    limit: int = 100,
    config: Mapping[str, object] | None = None,
) -> list[dict[str, object]]:
    """Return recent identity events visible to ``principal``, newest first.

    Reads the C5 log through :meth:`ChangeLog.list_changes`, so C2 visibility
    still applies — this view adds no read path of its own, it filters the one
    that already exists down to the events this module writes.
    """
    from hermes_cli.changes import ChangeLog

    log = ChangeLog(store, config=dict(config or {}))
    # Over-read, then filter: identity events are a small slice of a busy log.
    events = await log.list_changes(principal, limit=max(limit * 10, limit))
    rows: list[dict[str, object]] = []
    for event in events:
        payload = event.payload
        if not isinstance(payload, dict):
            continue
        action = str(payload.get("action") or "")
        if not action.startswith("user."):
            continue
        rows.append(
            {
                "change_ref": event.id,
                "actor_user_id": event.actor_user_id,
                "action": action,
                "user_id": str(payload.get("user_id") or ""),
                "payload": {
                    key: value
                    for key, value in payload.items()
                    if key not in ("action", "user_id")
                },
            }
        )
        if len(rows) >= limit:
            break
    return rows


async def _record_change(
    *,
    store: "SupabaseAppStore",
    actor_user_id: str,
    action: str,
    user_id: str,
    payload: dict[str, object],
    config: Mapping[str, object] | None,
) -> None:
    from hermes_cli.changes import ChangeLog, initialize_changes

    connection = await store.connect()
    try:
        await initialize_changes(connection)
    finally:
        await connection.close()
    op: Sequence[dict[str, object]] = [
        {"op": "record", "path": f"/users/{user_id}", "value": payload}
    ]
    await ChangeLog(store, config=dict(config or {})).record(
        actor_user_id=actor_user_id,
        target_kind="data",
        op=list(op),
        inverse_op=list(op),
        # An identity act is not undoable through the change log: replaying the
        # inverse would have to re-create a shared GoTrue account or re-mint a
        # consumed token. Recorded as reversible=True with a mirrored op only
        # because C5 requires an inverse for a non-approval-gated write; the
        # console offers no undo affordance for these.
        reversible=True,
        action=action,
        target_ref=target_ref(user_id),
        payload=payload,
        approved=True,
    )


async def _record_span(
    *,
    store: "SupabaseAppStore",
    actor_user_id: str,
    action: str,
    user_id: str,
    payload: dict[str, object],
    config: Mapping[str, object] | None,
) -> None:
    from hermes_cli.interactions import Interaction, InteractionLedger

    ledger = InteractionLedger(store, config=dict(config or {}))
    trace = uuid.uuid4().hex
    await ledger.append(
        Interaction(
            id=f"int_{uuid.uuid4().hex}",
            trace_id=f"trc_{trace}",
            parent_id=None,
            ts=datetime.now(timezone.utc),
            actor_user_id=actor_user_id,
            session_key="users-console",
            platform="api",
            kind="change",
            ref=target_ref(user_id),
            summary=action,
            payload_ref=None,
            mode=store.mode,
        )
    )


def _safe_payload(payload: Mapping[str, object] | None) -> dict[str, object]:
    """Drop anything credential-shaped before it reaches a durable ledger."""
    if not payload:
        return {}
    return {
        key: value
        for key, value in payload.items()
        if key not in _FORBIDDEN_KEYS
    }
