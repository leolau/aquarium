"""/background and /compress agents run as the sender, not as the operator."""

import dataclasses
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from gateway.config import Platform
from gateway.session import SessionSource
from tests.gateway.test_background_command import _make_runner
from tools.access_policy import denied_tools, files_root


def _source():
    return SessionSource(
        platform=Platform.TELEGRAM, user_id="12345", chat_id="67890", user_name="viewer"
    )


def _runner(*, store, stamp=None, raise_unavailable=False):
    runner = _make_runner()
    adapter = AsyncMock()
    adapter.send = AsyncMock()
    adapter.extract_media = MagicMock(return_value=([], "done"))
    adapter.extract_images = MagicMock(return_value=([], "done"))
    runner.adapters[Platform.TELEGRAM] = adapter
    runner._get_principal_store = lambda: store

    async def _enrich(source):
        if raise_unavailable:
            from gateway.run import PrincipalResolutionUnavailable

            raise PrincipalResolutionUnavailable("down")
        if stamp:
            return dataclasses.replace(source, **stamp)
        return source

    runner._enrich_channel_source_identity = _enrich
    return runner, adapter


async def _run_background(runner):
    with patch("gateway.run._resolve_runtime_agent_kwargs", return_value={"api_key": "k"}), \
         patch("run_agent.AIAgent") as MockAgent:
        agent = MagicMock()
        agent.run_conversation.return_value = {"final_response": "done", "messages": []}
        MockAgent.return_value = agent
        await runner._run_background_task("do it", _source(), "bg_test")
    return MockAgent


def _policy(kw):
    return (
        denied_tools(kw["internal_user_id"], kw["internal_user_role"], trusted_local=kw["trusted_local"]),
        files_root(kw["internal_user_id"], kw["internal_user_role"],
                   trusted_local=kw["trusted_local"], session_key="bg_test"),
    )


@pytest.mark.asyncio
async def test_background_from_enrolled_viewer_gets_viewer_limits(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    runner, _ = _runner(
        store=object(), stamp={"internal_user_id": "vic", "internal_user_role": "viewer"}
    )
    MockAgent = await _run_background(runner)
    kw = MockAgent.call_args.kwargs
    assert kw["internal_user_id"] == "vic"
    assert kw["internal_user_role"] == "viewer"
    assert kw["trusted_local"] is False
    denied, _ = _policy(kw)
    assert denied == denied_tools("vic", "viewer")
    assert {"terminal", "execute_code", "write_file"} <= denied


@pytest.mark.asyncio
async def test_background_from_unresolved_sender_with_store_is_restricted(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    runner, _ = _runner(store=object())
    MockAgent = await _run_background(runner)
    kw = MockAgent.call_args.kwargs
    assert kw["internal_user_id"] is None
    assert kw["trusted_local"] is False
    denied, root = _policy(kw)
    assert "terminal" in denied
    assert root is not None and "_unresolved" in root.parts


@pytest.mark.asyncio
async def test_background_without_store_keeps_local_trust():
    runner, _ = _runner(store=None)
    MockAgent = await _run_background(runner)
    assert MockAgent.call_args.kwargs["trusted_local"] is True


@pytest.mark.asyncio
async def test_background_refuses_when_principal_lookup_is_unavailable():
    from gateway.run import PRINCIPAL_UNAVAILABLE_REPLY

    runner, adapter = _runner(store=object(), raise_unavailable=True)
    MockAgent = await _run_background(runner)
    MockAgent.assert_not_called()
    adapter.send.assert_called_once()
    assert adapter.send.call_args.args[1] == PRINCIPAL_UNAVAILABLE_REPLY


@pytest.mark.asyncio
async def test_compress_agent_runs_as_the_sender():
    from tests.gateway.test_compress_command import _make_event, _make_history
    from tests.gateway.test_compress_command import _make_runner as _make_compress_runner

    history = _make_history()
    runner = _make_compress_runner(history)
    runner._get_principal_store = lambda: object()

    async def _enrich(source):
        return dataclasses.replace(source, internal_user_id="vic", internal_user_role="viewer")

    runner._enrich_channel_source_identity = _enrich
    agent = MagicMock()
    agent._cached_system_prompt = ""
    agent.tools = None
    agent.context_compressor.has_content_to_compress.return_value = True
    agent.session_id = "sess-1"
    agent._compress_context.return_value = (list(history), "")
    with (
        patch("gateway.run._resolve_runtime_agent_kwargs", return_value={"api_key": "k"}),
        patch("gateway.run._resolve_gateway_model", return_value="test-model"),
        patch("run_agent.AIAgent", return_value=agent) as MockAgent,
        patch("agent.model_metadata.estimate_request_tokens_rough", return_value=100),
    ):
        await runner._handle_compress_command(_make_event())
    kw = MockAgent.call_args.kwargs
    assert kw["internal_user_id"] == "vic"
    assert kw["internal_user_role"] == "viewer"
    assert kw["trusted_local"] is False
