#!/usr/bin/env python3
"""
Review→reply loop tests — the triage → work → draft → approve → send chain.

Exercises the seams that make the workflow safe, without live infra:
- work_request: skill-requested work registers a to-do; auto-start needs
  BOTH the skill's `auto_start` AND the channel's `triage.auto_work`.
- execute_proposal: pending/denied/missing approvals never send; approved
  sends the approval row's body (never argv text); a sent row can't replay.
- draft persistence: the review surface reads the same files PATCH wrote.
- command_for/parse_command_routing round-trip keeps account + subject.

Run: python -m pytest custom/tests/test_review_reply_loop.py -v
"""

import asyncio
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from shared import triage_handlers  # noqa: E402


def _batch(channel='whatsapp', source_phone='wa-main', msg_ids=('m1',)):
    """A whatsapp batch: arrivals are (source_phone, msg_id) pairs, the same
    ids the poller registered the arrivals under."""
    return {
        '_channel': channel,
        'source_phone': source_phone,
        'messages': [{'msg_id': m} for m in msg_ids],
    }


class WorkRequestHandlerTest(unittest.TestCase):
    """The skill asks; the config allows; only then does work start."""

    def _run(self, request, *, auto_work=False, register_result=None):
        registered = []
        started = []

        def fake_register(**kw):
            registered.append(kw)
            return register_result if register_result is not None else {
                'id': 'todo-1', 'stage': 'open', 'created': True,
            }

        with (
            patch.dict(
                sys.modules,
                {'shared.todo_registration': SimpleNamespace(
                    MAX_TODOS_PER_BATCH=3,
                    register_todo=fake_register,
                    select_candidates=lambda c, limit=3: c[:limit],
                )},
            ),
            patch.object(triage_handlers, '_auto_work_enabled',
                         return_value=auto_work),
            patch.object(triage_handlers, '_auto_start',
                         side_effect=lambda tid, ch: started.append(tid) or True),
        ):
            triage_handlers._handle_work_request(request, _batch(), db=None)
        return registered, started

    def test_registers_todo_with_instructions_and_deliverable(self):
        registered, _ = self._run({
            'title': 'Quote for Acme',
            'instructions': 'Use the price list',
            'deliverable': 'A quotation draft',
            'priority': 'high',
        })
        self.assertEqual(len(registered), 1)
        call = registered[0]
        self.assertEqual(call['title'], 'Quote for Acme')
        self.assertIn('Use the price list', call['description'])
        self.assertIn('Deliverable: A quotation draft', call['description'])
        self.assertEqual(call['surface'], 'whatsapp')
        self.assertEqual(call['account_id'], 'wa-main')
        self.assertEqual(call['origin'], 'triage')

    def test_auto_start_needs_both_gates(self):
        # Skill asks but config says no → registered, not started.
        _, started = self._run(
            {'title': 'X', 'auto_start': True}, auto_work=False
        )
        self.assertEqual(started, [])

        # Both gates open → one launch.
        _, started = self._run(
            {'title': 'X', 'auto_start': True}, auto_work=True
        )
        self.assertEqual(started, ['todo-1'])

    def test_one_auto_start_per_batch(self):
        _, started = self._run(
            [
                {'title': 'A', 'auto_start': True},
                {'title': 'B', 'auto_start': True},
            ],
            auto_work=True,
        )
        self.assertEqual(len(started), 1)

    def test_duplicate_todo_does_not_restart(self):
        _, started = self._run(
            {'title': 'X', 'auto_start': True},
            auto_work=True,
            register_result={'id': 'todo-1', 'stage': 'open', 'created': False},
        )
        self.assertEqual(started, [])


class RoutingTest(unittest.TestCase):
    def setUp(self):
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
        from hermes_cli import todo_outbound
        self.ob = todo_outbound

    def test_command_roundtrip_keeps_account_and_subject(self):
        action = self.ob.ProposedAction(
            channel='email', target='buyer@acme.com', body='the quote',
            account_id='work-gmail', thread_id='t-9', subject='Re: quote',
        )
        routing = self.ob.parse_command_routing(
            __import__('shlex').split(self.ob.command_for('t1', action))
        )
        self.assertEqual(
            routing,
            {'channel': 'email', 'target': 'buyer@acme.com',
             'thread': 't-9', 'account': 'work-gmail',
             'subject': 'Re: quote'},
        )


class _Approval:
    def __init__(self, *, pending=False, granted=True, command='', body=''):
        self.is_pending = pending
        self.granted = granted
        self.command = command
        self.body = body


class _Store:
    def __init__(self, approval=None, outbound=None):
        self._store = object()
        self._approval = approval
        self._outbound = outbound or []
        self.recorded = []

    async def list_outbound(self, principal, todo_id):
        return self._outbound

    async def record_outbound(self, principal, todo_id, *, event, channel, actor):
        self.recorded.append({'event': event, 'channel': channel})


class ExecuteProposalTest(unittest.TestCase):
    """The approval gate: only a granted, single-use approval can send."""

    def setUp(self):
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
        from hermes_cli import todo_outbound
        self.ob = todo_outbound
        self.principal = SimpleNamespace(user_id='leo')
        self.command = (
            'hermes todos send t1 --channel whatsapp --to +85290000000 '
            '--account wa-main'
        )

    def _run(self, approval, outbound=None, send_result='{"ok": true}'):
        store = _Store(approval=approval, outbound=outbound)
        notifications = SimpleNamespace(
            get_by_dedupe_key=AsyncMock(return_value=approval)
        )
        with (
            patch('hermes_cli.human_comms.NotificationStore',
                  return_value=notifications),
            patch('tools.send_message_tool.send_message_tool',
                  return_value=send_result) as send,
            patch('hermes_cli.send_cmd._load_hermes_env'),
        ):
            result = asyncio.run(
                self.ob.execute_proposal(store, self.principal, 't1')
            )
        return result, store, send

    def test_pending_is_not_sent(self):
        result, _, send = self._run(_Approval(pending=True))
        self.assertEqual(result['error'], 'pending')
        send.assert_not_called()

    def test_denied_is_not_sent(self):
        result, _, send = self._run(_Approval(granted=False))
        self.assertEqual(result['error'], 'denied')
        send.assert_not_called()

    def test_missing_approval_refuses(self):
        result, _, send = self._run(None)
        self.assertEqual(result['error'], 'no_approval')
        send.assert_not_called()

    def test_already_sent_cannot_replay(self):
        result, _, send = self._run(
            _Approval(command=self.command, body='hi'),
            outbound=[{'event': 'sent'}],
        )
        self.assertEqual(result['error'], 'already_sent')
        send.assert_not_called()

    def test_approved_sends_approval_body_with_account(self):
        result, store, send = self._run(
            _Approval(command=self.command, body='the approved reply')
        )
        self.assertEqual(result['event'], 'sent')
        args = send.call_args.args[0]
        self.assertEqual(args['message'], 'the approved reply')
        self.assertEqual(args['account'], 'wa-main')
        self.assertEqual(args['target'], 'whatsapp:+85290000000')
        self.assertEqual(store.recorded[0]['event'], 'sent')


class DraftPayloadTest(unittest.TestCase):
    """The review surface reads the same bytes the session/PATCH wrote."""

    def setUp(self):
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
        from hermes_cli import todos_api
        self.api = todos_api

    def test_reads_draft_and_reply_from_disk(self):
        with tempfile.TemporaryDirectory() as tmp:
            draft_dir = Path(tmp)
            (draft_dir / 'DRAFT.md').write_text('quote: $1200')
            (draft_dir / 'REPLY.txt').write_text('attached is your quote')
            todo = SimpleNamespace(
                id='t1',
                work_result={'draft_dir': tmp, 'summary': 'done',
                             'session_id': 's1'},
            )
            payload = self.api._draft_payload(todo)
        self.assertEqual(payload['draft_text'], 'quote: $1200')
        self.assertEqual(payload['reply_text'], 'attached is your quote')
        self.assertEqual(payload['summary'], 'done')
        self.assertEqual({f['name'] for f in payload['files']},
                         {'DRAFT.md', 'REPLY.txt'})

    def test_missing_draft_dir_returns_empty(self):
        todo = SimpleNamespace(id='t-x', work_result={'draft_dir': '/nope'})
        payload = self.api._draft_payload(todo)
        self.assertEqual(payload['draft_text'], '')
        self.assertEqual(payload['files'], [])


if __name__ == '__main__':
    unittest.main()
