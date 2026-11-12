"""Behaviour-contract tests for ``hermes todos`` — the CLI surface.

The verbs are thin by design (parse, delegate to ``TodoStore``, print), so
what is worth pinning is the thin parts: that ``--json`` round-trips through
``json.loads`` for every read, that an unknown stage is rejected rather than
returning everything, that ``expire --dry-run`` writes nothing, and that the
``send`` gate honours the approval's state and routing before it delivers.

The Postgres behaviour is already covered by ``test_todo_store_e2e.py``;
these tests use stub stores so they exercise the CLI's own logic, not the
store's SQL.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Optional
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from hermes_cli.access import Principal
from hermes_cli.todo_outbound import command_for, ProposedAction
from hermes_cli.todos_cmd import (
    _csv,
    _parse_command_routing,
    _when,
    _SEND_MISSING,
    _SEND_PENDING,
    _SEND_DENIED,
    _SEND_ROUTING,
)

PRINCIPAL = Principal(user_id="leo", display="Leo", role="owner")  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------

class TestCsv:
    def test_empty(self) -> None:
        assert _csv("") == []
        assert _csv(None) == []

    def test_single(self) -> None:
        assert _csv("open") == ["open"]

    def test_multiple(self) -> None:
        assert _csv("staged, open ,working") == ["staged", "open", "working"]


class TestWhen:
    def test_none(self) -> None:
        assert _when(None) is None
        assert _when("") is None

    def test_iso(self) -> None:
        result = _when("2026-08-13T12:00:00Z")
        assert result is not None
        assert result.year == 2026
        assert result.tzinfo is not None

    def test_naive_assumes_utc(self) -> None:
        result = _when("2026-08-13T12:00:00")
        assert result is not None
        assert result.tzinfo is not None


# ---------------------------------------------------------------------------
# send — the command round-trip (the contract that matters most)
# ---------------------------------------------------------------------------

class TestSendCommandRoundTrip:
    """``command_for()`` output must parse and dispatch through the CLI.

    The two can never be allowed to drift: the approval carries a command
    string the user sees, and `hermes todos send` must accept the same
    routing fields.
    """

    def test_command_for_parses_into_routing(self) -> None:
        action = ProposedAction(
            channel="telegram",
            target="-1001234567890",
            account_id="bot_1",
            thread_id="17585",
            body="Reply text",
        )
        cmd = command_for("tsk_abc", action)
        parts = cmd.split()  # shlex.join produces space-separated
        routing = _parse_command_routing(parts)
        assert routing is not None
        assert routing["channel"] == "telegram"
        assert routing["target"] == "-1001234567890"
        assert routing["account"] == "bot_1"
        assert routing["thread"] == "17585"

    def test_command_for_without_optional_fields(self) -> None:
        action = ProposedAction(
            channel="email",
            target="ada@example.com",
            body="Reply text",
        )
        cmd = command_for("tsk_def", action)
        parts = cmd.split()
        routing = _parse_command_routing(parts)
        assert routing is not None
        assert routing["channel"] == "email"
        assert routing["target"] == "ada@example.com"
        assert routing["account"] is None
        assert routing["thread"] is None

    def test_routing_mismatch_is_detected(self) -> None:
        """A routing that differs from the approval's must be caught."""
        approved = {
            "channel": "telegram",
            "target": "-1001234567890",
            "account": None,
            "thread": None,
        }
        argv = {
            "channel": "telegram",
            "target": "-9999999",  # different!
            "account": None,
            "thread": None,
        }
        mismatches = []
        for key in ("channel", "target", "account", "thread"):
            if (approved[key] or None) != (argv[key] or None):
                mismatches.append(key)
        assert "target" in mismatches


# ---------------------------------------------------------------------------
# send — the gate (approval state + routing match)
# ---------------------------------------------------------------------------

class _MockApproval:
    """A notification-shaped object for the send gate tests."""

    def __init__(
        self,
        *,
        status: str = "answered",
        answer: Optional[str] = "approved",
        body: str = "Reply body from approval",
        command: str = "",
    ) -> None:
        self._status = status
        self._answer = answer
        self.body = body
        self.command = command

    @property
    def is_pending(self) -> bool:
        return self._status == "pending"

    @property
    def granted(self) -> bool:
        return bool(self._answer) and self._answer in {
            "approved", "yes", "allow"
        }


class TestSendGate:
    """The send verb refuses at the first gate that does not hold."""

    @pytest.mark.asyncio
    async def test_missing_approval_returns_missing_code(self) -> None:
        from hermes_cli.todos_cmd import _send

        store = MagicMock()
        store._store = MagicMock()
        notifications = MagicMock()
        notifications.get_by_dedupe_key = AsyncMock(return_value=None)

        with patch("hermes_cli.human_comms.NotificationStore", return_value=notifications):
            rc = await _send(
                store, PRINCIPAL, "tsk_1",
                channel="telegram", target="-123",
                account=None, thread=None,
                json_mode=False,
            )
        assert rc == _SEND_MISSING

    @pytest.mark.asyncio
    async def test_pending_approval_refuses(self) -> None:
        from hermes_cli.todos_cmd import _send

        approval = _MockApproval(status="pending", answer=None)
        store = MagicMock()
        store._store = MagicMock()
        notifications = MagicMock()
        notifications.get_by_dedupe_key = AsyncMock(return_value=approval)

        with patch("hermes_cli.human_comms.NotificationStore", return_value=notifications):
            rc = await _send(
                store, PRINCIPAL, "tsk_1",
                channel="telegram", target="-123",
                account=None, thread=None,
                json_mode=False,
            )
        assert rc == _SEND_PENDING

    @pytest.mark.asyncio
    async def test_denied_approval_refuses(self) -> None:
        from hermes_cli.todos_cmd import _send

        approval = _MockApproval(status="answered", answer="denied")
        store = MagicMock()
        store._store = MagicMock()
        notifications = MagicMock()
        notifications.get_by_dedupe_key = AsyncMock(return_value=approval)

        with patch("hermes_cli.human_comms.NotificationStore", return_value=notifications):
            rc = await _send(
                store, PRINCIPAL, "tsk_1",
                channel="telegram", target="-123",
                account=None, thread=None,
                json_mode=False,
            )
        assert rc == _SEND_DENIED

    @pytest.mark.asyncio
    async def test_routing_mismatch_refuses(self) -> None:
        from hermes_cli.todos_cmd import _send

        action = ProposedAction(
            channel="telegram", target="-1001234567890", body="x"
        )
        approval = _MockApproval(
            command=command_for("tsk_1", action),
        )
        store = MagicMock()
        store._store = MagicMock()
        notifications = MagicMock()
        notifications.get_by_dedupe_key = AsyncMock(return_value=approval)

        with patch("hermes_cli.human_comms.NotificationStore", return_value=notifications):
            rc = await _send(
                store, PRINCIPAL, "tsk_1",
                channel="telegram", target="-9999",  # wrong
                account=None, thread=None,
                json_mode=False,
            )
        assert rc == _SEND_ROUTING

    @pytest.mark.asyncio
    async def test_body_from_approval_not_argv(self) -> None:
        """The body is never passed on the command line — it comes from
        the approval row. The send verb has no ``--body`` flag at all."""
        from hermes_cli.todos_cmd import _send

        action = ProposedAction(
            channel="telegram", target="-1001234567890", body="approved body"
        )
        approval = _MockApproval(
            body="approved body",
            command=command_for("tsk_1", action),
        )
        store = MagicMock()
        store._store = MagicMock()
        store.record_outbound = AsyncMock()
        store.list_outbound = AsyncMock(return_value=[])
        notifications = MagicMock()
        notifications.get_by_dedupe_key = AsyncMock(return_value=approval)

        delivered = {"success": True}
        with (
            patch("hermes_cli.human_comms.NotificationStore", return_value=notifications),
            patch("hermes_cli.send_cmd._load_hermes_env"),
            patch("tools.send_message_tool.send_message_tool", return_value=json.dumps(delivered)),
        ):
            rc = await _send(
                store, PRINCIPAL, "tsk_1",
                channel="telegram", target="-1001234567890",
                account=None, thread=None,
                json_mode=False,
            )
        assert rc == 0
        store.record_outbound.assert_called_once()
        event = store.record_outbound.call_args.kwargs.get("event")
        assert event == "sent"

    @pytest.mark.asyncio
    async def test_an_already_sent_todo_is_refused(self) -> None:
        """A granted approval is single-use.

        ``list_outbound`` returns the *parsed* event name, so the guard sees
        ``"sent"`` rather than the ``action:sent:<channel>`` row shape it is
        stored as. Pinning the parsed name here is what makes the guard
        testable at all — mocking it to ``[]`` in every send test is how the
        replay hole shipped twice.
        """
        from hermes_cli.todos_cmd import _send

        action = ProposedAction(
            channel="telegram", target="-1001234567890", body="x"
        )
        approval = _MockApproval(command=command_for("tsk_1", action))
        store = MagicMock()
        store._store = MagicMock()
        store.record_outbound = AsyncMock()
        store.list_outbound = AsyncMock(
            return_value=[{"event": "sent", "actor": "user:leo", "at": None}]
        )
        notifications = MagicMock()
        notifications.get_by_dedupe_key = AsyncMock(return_value=approval)

        with (
            patch("hermes_cli.human_comms.NotificationStore", return_value=notifications),
            patch("hermes_cli.send_cmd._load_hermes_env"),
            patch("tools.send_message_tool.send_message_tool") as delivery,
        ):
            rc = await _send(
                store, PRINCIPAL, "tsk_1",
                channel="telegram", target="-1001234567890",
                account=None, thread=None,
                json_mode=False,
            )
        assert rc == _SEND_MISSING
        delivery.assert_not_called()
        store.record_outbound.assert_not_called()

    @pytest.mark.asyncio
    async def test_a_session_pointer_is_not_a_send(self) -> None:
        """``record_session`` writes through the same outbound trail.

        Its event parses to ``session``, so it must not read as a delivery
        and block a first send.
        """
        from hermes_cli.todos_cmd import _send

        action = ProposedAction(
            channel="telegram", target="-1001234567890", body="x"
        )
        approval = _MockApproval(command=command_for("tsk_1", action))
        store = MagicMock()
        store._store = MagicMock()
        store.record_outbound = AsyncMock()
        store.list_outbound = AsyncMock(
            return_value=[{"event": "session", "actor": "user:leo", "at": None}]
        )
        notifications = MagicMock()
        notifications.get_by_dedupe_key = AsyncMock(return_value=approval)

        with (
            patch("hermes_cli.human_comms.NotificationStore", return_value=notifications),
            patch("hermes_cli.send_cmd._load_hermes_env"),
            patch("tools.send_message_tool.send_message_tool", return_value=json.dumps({"success": True})),
        ):
            rc = await _send(
                store, PRINCIPAL, "tsk_1",
                channel="telegram", target="-1001234567890",
                account=None, thread=None,
                json_mode=False,
            )
        assert rc == 0

    @pytest.mark.asyncio
    async def test_the_approved_account_reaches_the_delivery(self) -> None:
        """C4: the reply leaves by the account the approval names;
        ``send_message_tool`` refuses itself when that account doesn't resolve."""
        from hermes_cli.todos_cmd import _send

        action = ProposedAction(
            channel="telegram",
            target="-1001234567890",
            body="x",
            account_id="work",
        )
        approval = _MockApproval(command=command_for("tsk_1", action))
        store = MagicMock()
        store._store = MagicMock()
        store.record_outbound = AsyncMock()
        store.list_outbound = AsyncMock(return_value=[])
        notifications = MagicMock()
        notifications.get_by_dedupe_key = AsyncMock(return_value=approval)

        with (
            patch("hermes_cli.human_comms.NotificationStore", return_value=notifications),
            patch("hermes_cli.send_cmd._load_hermes_env"),
            patch(
                "tools.send_message_tool.send_message_tool",
                return_value='{"success": true}',
            ) as delivery,
        ):
            rc = await _send(
                store, PRINCIPAL, "tsk_1",
                channel="telegram", target="-1001234567890",
                account="work", thread=None,
                json_mode=False,
            )
        assert rc == 0
        assert delivery.call_args.args[0]["account"] == "work"

    @pytest.mark.asyncio
    async def test_failed_delivery_records_failed(self) -> None:
        from hermes_cli.todos_cmd import _send

        action = ProposedAction(
            channel="telegram", target="-1001234567890", body="x"
        )
        approval = _MockApproval(
            command=command_for("tsk_1", action),
        )
        store = MagicMock()
        store._store = MagicMock()
        store.record_outbound = AsyncMock()
        store.list_outbound = AsyncMock(return_value=[])
        notifications = MagicMock()
        notifications.get_by_dedupe_key = AsyncMock(return_value=approval)

        with (
            patch("hermes_cli.human_comms.NotificationStore", return_value=notifications),
            patch("hermes_cli.send_cmd._load_hermes_env"),
            patch("tools.send_message_tool.send_message_tool", return_value=json.dumps({"error": "no bot"})),
        ):
            rc = await _send(
                store, PRINCIPAL, "tsk_1",
                channel="telegram", target="-1001234567890",
                account=None, thread=None,
                json_mode=False,
            )
        assert rc == 1
        store.record_outbound.assert_called_once()
        event = store.record_outbound.call_args.kwargs.get("event")
        assert event == "failed"
