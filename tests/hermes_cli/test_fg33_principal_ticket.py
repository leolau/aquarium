"""FG-33 0.4: the requester, not the owner, authors what the agent builds.

The gateway mints a short-lived HMAC ticket per turn; the agent's terminal
carries it; ``deploy/hermes-tools-cli`` verifies it and maps it to ``--as``;
``hermes tool`` from the agent fails closed without it; a person's own shell
keeps ``--as``/owner; dashboard ``/api/tools*`` writes act as the caller.
"""

from __future__ import annotations

import asyncio
import importlib.machinery
import importlib.util
import os
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from hermes_cli import principal_ticket as pt

REPO = Path(__file__).resolve().parents[2]


def _load_cli():
    path = REPO / "deploy/hermes-tools-cli"
    loader = importlib.machinery.SourceFileLoader("hermes_tools_cli_fg33", str(path))
    spec = importlib.util.spec_from_loader("hermes_tools_cli_fg33", loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


cli = _load_cli()
KEY = b"k" * 64


@pytest.fixture(autouse=True)
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.delenv(pt.ENV_VAR, raising=False)
    monkeypatch.delenv("HERMES_TOOLS_CLI", raising=False)
    pt._CURRENT.set(None)
    return tmp_path


def _future(seconds=60):
    return int(time.time() * 1000) + seconds * 1000


# --- the ticket ---------------------------------------------------------------


@pytest.mark.parametrize("user_id", ["mia", "a.b@example.com", "用戶", "550e8400-e29b"])
def test_ticket_round_trips_and_cli_copy_agrees(user_id):
    ticket = pt.sign(user_id, KEY, _future())
    assert pt.verify(ticket, key=KEY) == user_id
    assert cli.verify_ticket(ticket, KEY) == user_id


def test_forged_expired_or_foreign_tickets_are_refused():
    good = pt.sign("mia", KEY, _future())
    head, uid, exp, sig = good.split(".")
    other_uid = pt._b64(b"root")
    bad = [
        "",
        "mia",
        pt.sign("mia", KEY, int(time.time() * 1000) - 1),  # expired
        pt.sign("mia", b"other-key", _future()),  # wrong key
        f"{head}.{other_uid}.{exp}.{sig}",  # identity swapped
        f"{head}.{uid}.{int(exp) + 10**9}.{sig}",  # lifetime extended
        f"v2.{uid}.{exp}.{sig}",
        good + ".x",
    ]
    for ticket in bad:
        assert pt.verify(ticket, key=KEY) is None, ticket
        assert cli.verify_ticket(ticket, KEY) is None, ticket


def test_mint_creates_a_private_key_and_a_widened_key_fails_closed(home):
    ticket = pt.mint("mia")
    key = home / "auth" / "principal-ticket.key"
    assert key.stat().st_mode & 0o777 == 0o600
    assert pt.verify(ticket) == "mia"
    key.chmod(0o640)
    assert pt.verify(ticket) is None
    assert pt.mint("mia") == ""


def test_a_turn_without_a_person_clears_the_previous_ticket():
    assert pt.mint("mia")
    assert pt.current()
    assert pt.mint(None) == ""
    assert pt.current() == ""


def test_ticket_is_bound_to_the_session_it_was_minted_in():
    from gateway.session_context import clear_session_vars, set_session_vars

    tokens = set_session_vars(session_id="s1")
    try:
        ticket = pt.mint("mia")
        assert pt.current() == ticket
    finally:
        clear_session_vars(tokens)
    tokens = set_session_vars(session_id="s2")
    try:
        assert pt.current() == ""
    finally:
        clear_session_vars(tokens)


def test_terminal_env_carries_this_turns_ticket_and_never_a_stale_one(monkeypatch):
    from tools.environments.local import _inject_session_context_env

    ticket = pt.mint("mia")
    env = {pt.ENV_VAR: "stale"}
    _inject_session_context_env(env)
    assert env[pt.ENV_VAR] == ticket

    pt.mint(None)
    env = {pt.ENV_VAR: "stale"}
    _inject_session_context_env(env)
    assert pt.ENV_VAR not in env


# --- deploy/hermes-tools-cli ----------------------------------------------------


def test_cli_maps_a_valid_ticket_to_as_for_tool_only():
    ticket = pt.sign("mia", KEY, _future())
    argv = ["tool", "new", "demo"]
    assert cli.as_requester(cli.check(argv), argv, ticket, KEY) == (
        ["tool", "--as=mia", "new", "demo"], ticket)
    argv = ["cron", "list"]
    assert cli.as_requester(cli.check(argv), argv, ticket, KEY) == (argv, "")


def test_cli_passes_nothing_on_for_a_forged_ticket_and_still_refuses_as():
    argv = ["tool", "new", "demo"]
    forged = pt.sign("root", b"guessed", _future())
    assert cli.as_requester(cli.check(argv), argv, forged, KEY) == (argv, "")
    assert cli.as_requester(cli.check(argv), argv, forged, b"") == (argv, "")
    with pytest.raises(cli.Refused):
        cli.check(["tool", "--as", "root", "new", "demo"])


def test_sudoers_keeps_the_ticket_for_the_helper():
    rule = (REPO / "deploy/sudoers.d/hermes-tools").read_text()
    keep = next(line for line in rule.splitlines() if "env_keep" in line)
    assert pt.ENV_VAR in keep and cli.TICKET_ENV == pt.ENV_VAR


# --- hermes tool operator resolution ---------------------------------------------


OWNER = SimpleNamespace(user_id="root", role="owner", active=True)
MIA = SimpleNamespace(user_id="mia", role="member", active=True)
GONE = SimpleNamespace(user_id="gone", role="member", active=False)


@pytest.fixture
def principals(monkeypatch):
    import hermes_cli.access as access

    people = {p.user_id: p for p in (OWNER, MIA, GONE)}

    class FakeStore:
        def __init__(self, store):
            pass

        async def get(self, user_id):
            return people.get(user_id)

        async def get_owner(self):
            return OWNER

    monkeypatch.setattr(access, "PrincipalStore", FakeStore)


def _resolve(as_user=None):
    from hermes_cli.tool_cmd import _resolve_operator

    return asyncio.run(_resolve_operator(object(), as_user))


def test_a_person_at_the_box_keeps_as_and_owner_default(principals):
    assert _resolve() is OWNER
    assert _resolve("mia") is MIA


def test_agent_call_acts_as_the_ticket_requester(principals, monkeypatch):
    monkeypatch.setenv("HERMES_TOOLS_CLI", "tool new")
    monkeypatch.setenv(pt.ENV_VAR, pt.mint("mia"))
    assert _resolve("mia") is MIA
    with pytest.raises(SystemExit):
        _resolve("root")


@pytest.mark.parametrize("ticket", ["", "forged", "v1.cm9vdA.99999999999999.x"])
def test_agent_call_without_a_valid_ticket_never_falls_back_to_owner(
    principals, monkeypatch, ticket
):
    pt.mint("mia")  # a key exists; the ticket still has to verify
    monkeypatch.setenv("HERMES_TOOLS_CLI", "tool new")
    monkeypatch.setenv(pt.ENV_VAR, ticket)
    with pytest.raises(SystemExit, match="principal ticket"):
        _resolve()


def test_a_ticket_alone_marks_an_agent_call(principals, monkeypatch):
    monkeypatch.setenv(pt.ENV_VAR, "forged")
    with pytest.raises(SystemExit):
        _resolve()


def test_an_inactive_requester_is_refused(principals, monkeypatch):
    monkeypatch.setenv(pt.ENV_VAR, pt.mint("gone"))
    with pytest.raises(SystemExit, match="not an active principal"):
        _resolve()


# --- dashboard /api/tools* writes act as the caller -----------------------------


ADMIN = SimpleNamespace(user_id="ann", display="Ann", role="admin", is_owner=False)


@pytest.fixture
def dashboard(monkeypatch):
    try:
        from starlette.testclient import TestClient
    except ImportError:  # pragma: no cover
        pytest.skip("fastapi/starlette not installed")
    import hermes_cli.datastore as datastore
    import hermes_cli.tool_cmd as tool_cmd
    import hermes_cli.tools_registry as tools_registry
    from hermes_cli import web_server

    seen = {}

    async def caller(request, *, allow_as=False):
        return ADMIN

    async def no_owner(*a, **k):  # pragma: no cover - must not be consulted
        raise AssertionError("dashboard tool writes must not resolve the owner")

    tool = SimpleNamespace(mode="prod", visibility="private", status="enabled",
                           config_json={}, as_dict=lambda: {"ok": True})

    class Registry:
        def __init__(self, store):
            pass

        async def initialize(self):
            pass

        async def set_enabled(self, operator, name, enabled):
            seen["enabled"] = operator.user_id
            return tool

        async def set_config(self, operator, name, config):
            seen["config"] = operator.user_id
            return tool

    async def promote(store, name, *, actor, approved):
        seen["promote"] = actor
        return SimpleNamespace(tool_name=name, approval_ref="a", change_ref="c",
                               promotion_ref="p")

    async def provenance(*a, **k):
        seen.setdefault("provenance", []).append(k["actor_user_id"])

    monkeypatch.setattr(web_server, "_comms_resolve_principal", caller)
    monkeypatch.setattr(web_server, "_comms_session_subject", lambda request: "ann")
    monkeypatch.setattr(datastore, "get_store", lambda *a, **k: object())
    monkeypatch.setattr(tools_registry, "ToolRegistry", Registry)
    monkeypatch.setattr(tools_registry, "promote_tool", promote)
    monkeypatch.setattr(tool_cmd, "_record_provenance", provenance)
    import hermes_cli.access as access

    monkeypatch.setattr(access.PrincipalStore, "get_owner", no_owner)
    client = TestClient(web_server.app)
    client.headers[web_server._SESSION_HEADER_NAME] = web_server._SESSION_TOKEN
    return client, seen


def test_dashboard_tool_writes_are_attributed_to_the_caller(dashboard):
    client, seen = dashboard
    assert client.put("/api/tools/demo/enabled", json={"enabled": False}).status_code == 200
    assert client.put("/api/tools/demo/config", json={"config": {}}).status_code == 200
    assert client.post("/api/tools/demo/promote", json={}).status_code == 200
    assert seen["enabled"] == seen["config"] == seen["promote"] == "ann"
    assert seen["provenance"] == ["ann", "ann"]
