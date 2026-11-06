"""The agent-home chat turn must run under the requested profile's brain.

``_open_session_db_for_profile`` has always filed the transcript under the
requested profile, but the turn itself was built from the dashboard process's
own ``HERMES_HOME`` — the default profile's config/SOUL answering as another
profile, and its reply stored in that profile's session history. These tests
drive the real endpoint (a stub stands in for the model turn only) and assert
what the agent would actually see.
"""

import asyncio
from pathlib import Path
from types import SimpleNamespace
from typing import TYPE_CHECKING, cast

import pytest

import hermes_constants
from hermes_cli import web_server

if TYPE_CHECKING:
    from starlette.requests import Request


@pytest.fixture()
def two_profiles(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A dashboard home with a named ``support`` profile beside it."""
    home = tmp_path / "hermes-home"
    (home / "profiles" / "support").mkdir(parents=True)
    (home / "SOUL.md").write_text("dashboard soul\n")
    (home / "profiles" / "support" / "SOUL.md").write_text("support soul\n")
    (home / ".env").write_text("MODEL_KEY=dashboard-key\n")
    (home / "profiles" / "support" / ".env").write_text("MODEL_KEY=support-key\n")
    monkeypatch.setenv("HERMES_HOME", str(home))
    # The dashboard process loads its own .env into os.environ at startup; an
    # unscoped read is supposed to see exactly that.
    monkeypatch.setenv("MODEL_KEY", "dashboard-key")
    return home


def _observed_scope() -> dict:
    """What the turn sees: the home its config resolves from, and its secrets."""
    from agent.secret_scope import get_secret

    return {
        "home": str(hermes_constants.get_hermes_home()),
        "model_key": get_secret("MODEL_KEY"),
    }


def _drive_chat(
    monkeypatch: pytest.MonkeyPatch,
    profile: str | None,
    turn=None,
) -> dict:
    """Call the real ``session_chat`` handler, stubbing only the model turn."""
    seen: dict = {}

    def fake_turn(**kwargs):
        seen.update(turn() if turn else _observed_scope())
        return {"final_response": "ok", "session_id": kwargs["session_id"]}, {}

    monkeypatch.setattr(
        "gateway.session_chat.run_session_turn_sync", fake_turn, raising=False
    )

    class _DB:
        def resolve_session_id(self, sid):
            return sid

        def resolve_resume_session_id(self, sid):
            return sid

        def get_messages_as_conversation(self, sid):
            return []

        def close(self):
            pass

    monkeypatch.setattr(
        web_server, "_open_session_db_for_profile", lambda _p: _DB()
    )
    monkeypatch.setattr(
        web_server,
        "_comms_resolve_principal",
        _async(SimpleNamespace(user_id="root", display="Root", role="owner", is_owner=True)),
    )
    monkeypatch.setattr(web_server, "_agent_home_trace", lambda *a, **k: (None, None))

    body = {"message": "hello"}
    if profile is not None:
        body["profile"] = profile
    # The handler reads only ``await request.json()``; a Starlette Request would
    # need a live ASGI scope to build.
    request = cast("Request", SimpleNamespace(json=_async(body), state=SimpleNamespace()))

    result = asyncio.new_event_loop().run_until_complete(
        web_server.session_chat("home_1", request)
    )
    assert result["message"]["content"] == "ok"
    return seen


def _drive_chat_stream(monkeypatch: pytest.MonkeyPatch, profile: str | None) -> dict:
    """Same for the streamed endpoint — it runs its own executor worker, so a
    scope entered only in the non-streaming one would leave this path wrong."""
    seen: dict = {}

    def fake_turn(**kwargs):
        seen.update(_observed_scope())
        return {"final_response": "ok", "session_id": kwargs["session_id"]}, {}

    monkeypatch.setattr(
        "gateway.session_chat.run_session_turn_sync", fake_turn, raising=False
    )

    class _DB:
        def resolve_session_id(self, sid):
            return sid

        def resolve_resume_session_id(self, sid):
            return sid

        def get_messages_as_conversation(self, sid):
            return []

        def close(self):
            pass

    monkeypatch.setattr(web_server, "_open_session_db_for_profile", lambda _p: _DB())
    monkeypatch.setattr(
        web_server,
        "_comms_resolve_principal",
        _async(SimpleNamespace(user_id="root", display="Root", role="owner", is_owner=True)),
    )
    monkeypatch.setattr(web_server, "_agent_home_trace", lambda *a, **k: (None, None))
    monkeypatch.setattr(web_server, "_flush_agent_home_trace", _async(None))

    body = {"message": "hello"}
    if profile is not None:
        body["profile"] = profile
    request = cast("Request", SimpleNamespace(json=_async(body), state=SimpleNamespace()))

    async def _run() -> str:
        response = await web_server.session_chat_stream("home_1", request)
        chunks = [chunk async for chunk in response.body_iterator]
        return b"".join(
            c if isinstance(c, bytes) else c.encode() for c in chunks
        ).decode()

    events = asyncio.new_event_loop().run_until_complete(_run())
    assert "assistant.completed" in events
    return seen


def _async(value):
    async def _call(*_args, **_kwargs):
        return value

    return _call


def test_turn_runs_under_the_requested_profile(
    two_profiles: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen = _drive_chat(monkeypatch, "support")
    assert seen["home"] == str(two_profiles / "profiles" / "support")
    assert seen["model_key"] == "support-key"


def test_streamed_turn_runs_under_the_requested_profile(
    two_profiles: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen = _drive_chat_stream(monkeypatch, "support")
    assert seen["home"] == str(two_profiles / "profiles" / "support")
    assert seen["model_key"] == "support-key"


def test_streamed_turn_without_a_profile_is_unchanged(
    two_profiles: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen = _drive_chat_stream(monkeypatch, None)
    assert seen["home"] == str(two_profiles)
    assert seen["model_key"] == "dashboard-key"


def test_no_profile_is_a_transparent_pass_through(
    two_profiles: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen = _drive_chat(monkeypatch, None)
    assert seen["home"] == str(two_profiles)
    assert seen["model_key"] == "dashboard-key"


def test_scope_is_released_after_the_turn(
    two_profiles: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A scoped turn must not leave the process pointed at that profile."""
    _drive_chat(monkeypatch, "support")
    assert str(hermes_constants.get_hermes_home()) == str(two_profiles)


def test_unknown_profile_is_refused_before_the_turn(
    two_profiles: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as excinfo:
        with web_server._chat_turn_profile_scope("no-such-profile"):
            pass
    assert excinfo.value.status_code == 404


def test_profile_naming_the_dashboards_own_home_is_a_pass_through(
    two_profiles: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``default`` resolves to the dashboard's own home: no scope, no churn."""
    monkeypatch.setattr(
        web_server, "_cron_profile_home", lambda _p: ("default", two_profiles)
    )
    with web_server._chat_turn_profile_scope("default") as scoped:
        assert scoped is None
        assert str(hermes_constants.get_hermes_home()) == str(two_profiles)


def test_the_gateway_multiplexer_scopes_identically(two_profiles: Path) -> None:
    """One mechanism: the gateway's per-turn scope must do exactly this."""
    from gateway import run as gateway_run

    support = two_profiles / "profiles" / "support"
    with gateway_run._profile_runtime_scope(support):
        assert _observed_scope() == {
            "home": str(support),
            "model_key": "support-key",
        }
    assert _observed_scope()["home"] == str(two_profiles)


def test_config_resolves_from_the_scoped_profile(
    two_profiles: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The real config loader, not a stub: the profile's own settings win."""
    (two_profiles / "config.yaml").write_text(
        "agent:\n  reasoning_effort: low\n"
    )
    (two_profiles / "profiles" / "support" / "config.yaml").write_text(
        "agent:\n  reasoning_effort: high\n"
    )

    def read_config() -> dict:
        from hermes_cli.config import load_config

        return {"effort": (load_config() or {}).get("agent", {}).get(
            "reasoning_effort"
        )}

    assert _drive_chat(monkeypatch, "support", turn=read_config)["effort"] == "high"
    assert _drive_chat(monkeypatch, None, turn=read_config)["effort"] == "low"
