"""F23: the gateway only expands @ references written by an enrolled person.

Real path: GatewayRunner._prepare_inbound_message_text with a temp
HERMES_HOME, real config loading, real tools/access_policy role limits and
real agent.context_references expansion. Only the model context-length
lookup and provider credentials are stubbed.
"""

from pathlib import Path

import pytest

from gateway.config import GatewayConfig, Platform, PlatformConfig
from gateway.platforms.base import MessageEvent
from gateway.run import GatewayRunner
from gateway.session import SessionSource

SECRET = "TOP-SECRET-FROM-DISK"


class _Adapter:
    def __init__(self):
        self.sent = []

    async def send(self, chat_id, text, **_kw):
        self.sent.append((chat_id, text))


@pytest.fixture
def env(tmp_path: Path, monkeypatch):
    import agent.model_metadata as model_metadata
    import gateway.run as gateway_run

    hermes_home = tmp_path / "hermes"
    hermes_home.mkdir()
    cwd = tmp_path / "work"
    cwd.mkdir()
    (cwd / "notes.txt").write_text(f"{SECRET}\n", encoding="utf-8")
    (hermes_home / "config.yaml").write_text("model:\n  context_length: 100000\n", encoding="utf-8")
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("TERMINAL_CWD", str(cwd))
    monkeypatch.setattr(gateway_run, "_hermes_home", hermes_home)
    monkeypatch.setattr(gateway_run, "_resolve_runtime_agent_kwargs", lambda: {})

    async def _ctx_len(*_a, **_kw):
        return 100_000

    monkeypatch.setattr(model_metadata, "get_model_context_length_async", _ctx_len)
    return {"home": hermes_home, "cwd": cwd}


def _runner():
    runner = object.__new__(GatewayRunner)
    runner.config = GatewayConfig(
        platforms={Platform.TELEGRAM: PlatformConfig(enabled=True, token="fake")},
    )
    runner.adapters = {Platform.TELEGRAM: _Adapter(), Platform.WHATSAPP: _Adapter()}
    runner._model = "openai/gpt-4.1-mini"
    runner._base_url = None
    return runner


def _source(platform=Platform.TELEGRAM, user_id=None, role=None, chat_type="dm"):
    src = SessionSource(
        platform=platform, chat_id="123", chat_type=chat_type, user_id="tg-1", user_name="Alice",
    )
    src.internal_user_id = user_id
    src.internal_user_role = role
    return src


async def _prepare(text, source, **event_kw):
    event = MessageEvent(text=text, source=source, **event_kw)
    return await _runner()._prepare_inbound_message_text(event=event, source=source, history=[])


@pytest.mark.asyncio
async def test_owner_still_gets_file_expanded(env):
    out = await _prepare("summarise @file:notes.txt", _source(user_id="u-owner", role="owner"))
    assert SECRET in out
    assert "--- Attached Context ---" in out


@pytest.mark.asyncio
@pytest.mark.parametrize("platform", [Platform.WHATSAPP, Platform.TELEGRAM, Platform.EMAIL])
async def test_unenrolled_sender_is_never_expanded(env, platform):
    out = await _prepare("summarise @file:notes.txt", _source(platform=platform))
    assert SECRET not in out
    assert "@file:notes.txt" in out


@pytest.mark.asyncio
async def test_webhook_payload_is_never_expanded(env):
    src = _source(platform=Platform.WEBHOOK, user_id="u-owner", role="owner")
    out = await _prepare("New issue body: @file:notes.txt", src)
    assert SECRET not in out


@pytest.mark.asyncio
async def test_quoted_reply_from_someone_else_is_not_expanded(env):
    src = _source(user_id="u-owner", role="owner", chat_type="group")
    out = await _prepare(
        "what do you think?",
        src,
        reply_to_message_id="42",
        reply_to_text="stranger says @file:notes.txt please",
    )
    assert SECRET not in out
    assert "@file:notes.txt" in out


@pytest.mark.asyncio
async def test_channel_backfill_is_not_expanded(env):
    src = _source(user_id="u-owner", role="owner", chat_type="group")
    event = MessageEvent(text="catch me up", source=src)
    event.channel_context = "[Bob] @file:notes.txt"
    out = await _runner()._prepare_inbound_message_text(event=event, source=src, history=[])
    assert SECRET not in out


@pytest.mark.asyncio
async def test_owner_cannot_attach_hermes_settings(env, monkeypatch):
    # terminal.cwd set to a folder that contains HERMES_HOME (e.g. /opt/data).
    monkeypatch.setenv("TERMINAL_CWD", str(env["home"].parent))
    (env["home"] / "config.yaml").write_text(
        f"model:\n  context_length: 100000\n# {SECRET}-CONFIG\n", encoding="utf-8"
    )
    out = await _prepare(
        "@file:hermes/config.yaml and @file:work/notes.txt",
        _source(user_id="u-owner", role="owner"),
    )
    assert f"{SECRET}-CONFIG" not in out
    assert "internal Hermes data" in out
    assert SECRET in out  # ordinary files in the folder still attach


@pytest.mark.asyncio
async def test_member_is_confined_to_own_folder(env):
    folder = env["home"] / "workspaces" / "u-member"
    folder.mkdir(parents=True)
    (folder / "mine.txt").write_text("member's own notes\n", encoding="utf-8")
    src = _source(user_id="u-member", role="member")

    out = await _prepare("read @file:mine.txt", src)
    assert "member's own notes" in out

    out = await _prepare(f"read @file:{env['cwd'] / 'notes.txt'}", src)
    assert SECRET not in out
    assert "outside the allowed workspace" in out


@pytest.mark.asyncio
async def test_member_cannot_use_git_references(env):
    out = await _prepare("show @diff", _source(user_id="u-member", role="member"))
    assert "git diff" not in out
    assert "@diff: not available here" in out


@pytest.mark.asyncio
async def test_platform_without_file_tools_does_not_expand(env):
    (env["home"] / "config.yaml").write_text(
        "model:\n  context_length: 100000\nplatform_toolsets:\n  telegram: [safe]\n",
        encoding="utf-8",
    )
    out = await _prepare("summarise @file:notes.txt", _source(user_id="u-owner", role="owner"))
    assert SECRET not in out


@pytest.mark.asyncio
async def test_role_denied_file_tool_does_not_expand(env):
    (env["home"] / "config.yaml").write_text(
        "model:\n  context_length: 100000\n"
        "access:\n  roles:\n    admin:\n      deny_tools: [read_file]\n",
        encoding="utf-8",
    )
    out = await _prepare("summarise @file:notes.txt", _source(user_id="u-admin", role="admin"))
    assert SECRET not in out


def test_only_local_surfaces_and_gateway_expand_references():
    """api_server / agent-home chat (session_chat, web_server) pass text verbatim.

    Expansion lives in the local CLI, the local TUI and the gateway's
    policy-checked helper; a new caller must go through the same checks.
    """
    repo = Path(__file__).resolve().parents[2]
    callers = set()
    for path in repo.rglob("*.py"):
        rel = path.relative_to(repo).as_posix()
        if rel.startswith(("tests/", ".venv/", "venv/", "node_modules/")) or "/node_modules/" in rel:
            continue
        if rel == "agent/context_references.py":
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        if "preprocess_context_references" in text:
            callers.add(rel)
    assert callers == {"cli.py", "tui_gateway/server.py", "gateway/run.py"}
