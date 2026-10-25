"""FG-33 P8-2 item 2.4: archive / restore / purge (CLI, API, runtime effects).

Decision 9: the app's owner or an admin acts without C6 approval; purge needs
one explicit confirmation (the tool name) and only follows an archive. The
root helpers are replaced at the ``HelperClient`` seam by the P8-1 ``FakeBox``;
registry, runtime tables, C5 rows and prod approvals run against a throwaway
Postgres.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from types import SimpleNamespace

import pytest

from hermes_cli import app_runtime as rt
from hermes_cli import app_watch as aw
from hermes_cli.access import Principal
from hermes_cli.app_store import AppStore
from hermes_cli.datastore import get_store
from hermes_cli.tools_registry import ToolRegistry
from tests.hermes_cli.test_fg33_local_e2e import (  # noqa: F401 - postgres_dsn is a fixture
    FakeBox,
    _cli,
    _config,
    _fetch,
    _reset,
    postgres_dsn,
)

_OWNER = Principal(user_id="root", display="Root", role="owner")
_ALICE = Principal(user_id="alice", display="Alice", role="member")
_BOB = Principal(user_id="bob", display="Bob", role="member")


@pytest.fixture
def no_quota(monkeypatch):
    import hermes_cli

    monkeypatch.setitem(sys.modules, "hermes_cli.app_quota", None)
    monkeypatch.delattr(hermes_cli, "app_quota", raising=False)


# ── the agent can never reach the lifecycle ──────────────────────────────────

@pytest.mark.parametrize("argv", [
    ["tool", "archive", "notes"],
    ["tool", "restore", "notes"],
    ["tool", "purge", "notes"],
    ["tool", "purge", "notes", "--yes-destroy", "notes"],
    ["tool", "--mode", "prod", "purge", "notes", "--yes-destroy=notes"],
    ["tool", "set", "notes", "--coder-profile", "internal-coder"],
])
def test_hermes_tools_cli_refuses_lifecycle_and_set(argv):
    cli = _cli()
    with pytest.raises(cli.Refused):
        cli.check(argv)
    assert "archive" not in cli.COMMANDS["tool"]["subs"]
    assert {"restore", "purge", "set"}.isdisjoint(cli.COMMANDS["tool"]["subs"])


@pytest.mark.parametrize("env", ["HERMES_TOOLS_CLI", "HERMES_PRINCIPAL_TICKET"])
def test_tool_cmd_refuses_lifecycle_from_the_agent_shell(monkeypatch, env):
    from hermes_cli import principal_ticket, tool_cmd

    monkeypatch.delenv("HERMES_TOOLS_CLI", raising=False)
    monkeypatch.delenv(principal_ticket.ENV_VAR, raising=False)
    monkeypatch.setenv(env if env == "HERMES_TOOLS_CLI" else principal_ticket.ENV_VAR, "1")
    for verb in aw.LIFECYCLE_VERBS:
        args = SimpleNamespace(name="notes", yes_destroy="notes")
        with pytest.raises(SystemExit, match="a person's act"):
            asyncio.run(tool_cmd._cmd_lifecycle(args, verb, _OWNER, object()))


def test_cli_parses_lifecycle_and_set():
    from hermes_cli.tool_cmd import register_tool_subparser

    parser = argparse.ArgumentParser()
    register_tool_subparser(parser.add_subparsers())
    args = parser.parse_args(["tool", "purge", "notes", "--mode", "prod", "--yes-destroy", "notes"])
    assert (args.tool_action, args.name, args.mode, args.yes_destroy) == ("purge", "notes", "prod", "notes")
    args = parser.parse_args(["tool", "archive", "notes"])
    assert (args.tool_action, getattr(args, "mode", None)) == ("archive", None)
    args = parser.parse_args(["tool", "set", "notes", "--coder-profile", "external-coder"])
    assert (args.tool_action, args.coder_profile) == ("set", "external-coder")
    with pytest.raises(SystemExit):
        parser.parse_args(["tool", "set", "notes"])


# ── tool set --coder-profile (item 2.9's verb, guarded) ──────────────────────

class _OneTool:
    mode = "dev"

    def __init__(self, owner):
        self.tool = SimpleNamespace(name="notes", owner_user_id=owner)

    async def get_for_principal(self, principal, name):
        return self.tool if name == "notes" else None


def test_tool_set_calls_app_coder_after_the_c2_check(monkeypatch):
    from hermes_cli import tool_cmd

    calls = []
    fake = SimpleNamespace(set_coder_profile=lambda name, profile: calls.append((name, profile)))
    monkeypatch.setitem(sys.modules, "hermes_cli.app_coder", fake)
    args = SimpleNamespace(name="notes", coder_profile="internal-coder")
    asyncio.run(tool_cmd._cmd_set(args, _ALICE, _OneTool("alice")))
    assert calls == [("notes", "internal-coder")]
    with pytest.raises(SystemExit, match="refused"):
        asyncio.run(tool_cmd._cmd_set(args, _BOB, _OneTool("alice")))
    with pytest.raises(SystemExit, match="no tool named"):
        asyncio.run(tool_cmd._cmd_set(SimpleNamespace(name="other", coder_profile="x"),
                                      _ALICE, _OneTool("alice")))
    assert calls == [("notes", "internal-coder")]

    async def bad(name, profile):
        raise ValueError(f"unknown coder profile {profile!r}")

    monkeypatch.setitem(sys.modules, "hermes_cli.app_coder", SimpleNamespace(set_coder_profile=bad))
    with pytest.raises(SystemExit, match="unknown coder profile"):
        asyncio.run(tool_cmd._cmd_set(args, _ALICE, _OneTool("alice")))


def test_tool_set_without_item_29_refuses(monkeypatch):
    from hermes_cli import tool_cmd

    monkeypatch.setitem(sys.modules, "hermes_cli.app_coder", None)
    with pytest.raises(SystemExit, match="no coder profiles yet"):
        asyncio.run(tool_cmd._cmd_set(SimpleNamespace(name="notes", coder_profile="x"),
                                      _ALICE, _OneTool("alice")))


# ── API router: caller, confirmation and error mapping ───────────────────────

@pytest.fixture
def api(monkeypatch):
    from fastapi import FastAPI
    from starlette.testclient import TestClient

    import hermes_cli.datastore as datastore
    import hermes_cli.tools_registry as tools_registry
    from hermes_cli import app_lifecycle_api, web_server

    seen: dict = {}
    who = {"as": _ALICE}

    async def caller(request, *, allow_as=False):
        return who["as"]

    class Registry:
        def __init__(self, store):
            self.mode = store

        async def initialize(self):
            pass

    async def archive(runtime, registry, principal, name, **kw):
        seen["archive"] = (principal.user_id, registry.mode, name)
        if name == "missing":
            raise KeyError(name)
        if name == "theirs":
            raise PermissionError("may not manage")
        if name == "gone":
            raise aw.LifecycleConflict("already archived")
        if name == "broken":
            raise rt.HelperError("aquarium-app-helper stop failed")
        return {"tool": name, "lifecycle_state": "archived"}

    async def restore(runtime, registry, principal, name, **kw):
        seen["restore"] = (principal.user_id, registry.mode)
        if name == "full":
            raise rt.AdmissionRefused("per-member running apps (2/2)")
        return {"tool": name, "lifecycle_state": "active"}

    async def purge(runtime, registry, principal, name, *, confirm, other_registry=None, **kw):
        if confirm != name:
            raise ValueError("confirm by repeating the tool name")
        seen["purge"] = (principal.user_id, registry.mode, other_registry.mode)
        return {"tool": name, "lifecycle_state": "purged"}

    monkeypatch.setattr(web_server, "_comms_resolve_principal", caller)
    monkeypatch.setattr(datastore, "get_store", lambda kind, mode, **k: mode)
    monkeypatch.setattr(tools_registry, "ToolRegistry", Registry)
    monkeypatch.setattr(rt, "AppRuntime", lambda: object())
    monkeypatch.setattr(aw, "archive_app", archive)
    monkeypatch.setattr(aw, "restore_app", restore)
    monkeypatch.setattr(aw, "purge_app", purge)
    app = FastAPI()
    app.include_router(app_lifecycle_api.router)
    return TestClient(app, raise_server_exceptions=False), seen, who


def test_lifecycle_routes_act_as_the_caller_and_map_errors(api):
    client, seen, who = api
    assert client.post("/api/tools/notes/archive").status_code == 200
    assert seen["archive"] == ("alice", "dev", "notes")  # a member, default dev, no approval
    assert client.post("/api/tools/notes/archive", json={"mode": "prod"}).status_code == 200
    assert seen["archive"][1] == "prod"
    assert client.post("/api/tools/missing/archive", json={}).status_code == 404
    assert client.post("/api/tools/theirs/archive", json={}).status_code == 403
    assert client.post("/api/tools/gone/archive", json={}).status_code == 409
    assert client.post("/api/tools/broken/archive", json={}).status_code == 502
    assert client.post("/api/tools/full/restore", json={}).status_code == 409
    assert client.post("/api/tools/notes/restore", json={}).json()["lifecycle_state"] == "active"
    assert client.post("/api/tools/notes/purge", json={}).status_code == 400
    assert client.post("/api/tools/notes/purge", json={"confirm": "other"}).status_code == 400
    assert "purge" not in seen
    ok = client.post("/api/tools/notes/purge", json={"confirm": "notes", "mode": "prod"})
    assert ok.status_code == 200 and seen["purge"] == ("alice", "prod", "dev")


def test_lifecycle_routes_are_handler_checked_members():
    """When item 2.2 mounts the router, every route resolves the caller itself."""
    import inspect

    from hermes_cli import app_lifecycle_api

    paths = {(sorted(r.methods)[0], r.path) for r in app_lifecycle_api.router.routes}
    assert paths == {("POST", f"/api/tools/{{name}}/{v}") for v in aw.LIFECYCLE_VERBS}
    for route in app_lifecycle_api.router.routes:
        assert "_lifecycle_call" in inspect.getsource(route.endpoint)


# ── E2E: archive → restore → archive → purge against a throwaway Postgres ────

class LifecycleBox(FakeBox):
    """FakeBox that also checks the prod approval on suspend/resume."""

    def _db(self, verb, slug, mode, spec):
        if mode == "prod" and verb in ("suspend", "resume"):
            ref = spec.get("approval_ref")
            if not ref or not asyncio.run(self._approved(ref)):
                return 1, json.dumps({"ok": False, "error": "needs an approved approval_ref"}), ""
        return super()._db(verb, slug, mode, spec)


async def _local_app(reg, principal, name, repo, *, mode="dev"):
    repo.mkdir(parents=True, exist_ok=True)
    (repo / "package.json").write_text("{}")
    tool = await reg.create(principal, name, "in_house", hosting="local", repo_path=str(repo),
                            status="enabled", build_state="ready")
    store = AppStore(reg.store)
    await store.initialize()
    await store.set_tool_build(tool.id, "ready", release_sha="abc1234")
    await store.upsert_database(tool.id, mode, rt.app_db_name(name, mode), status="ready")
    await store.set_runtime(tool.id, runtime="local", runtime_state="running", port=4501)
    return await reg.get(name), store


@pytest.mark.asyncio
async def test_archive_restore_purge_as_a_member(postgres_dsn, tmp_path, monkeypatch, no_quota):
    await _reset(postgres_dsn)
    cfg = _config(postgres_dsn)
    box = LifecycleBox(postgres_dsn)
    monkeypatch.setattr(rt, "_default_runner", box)
    dev = ToolRegistry(get_store("supabase-app", "dev", config=cfg))
    prod = ToolRegistry(get_store("supabase-app", "prod", config=cfg))
    await dev.initialize()
    await prod.initialize()
    tools_root = tmp_path / "tools"
    secrets = tmp_path / "secrets"
    secrets.mkdir()
    runtime = rt.AppRuntime(tools_root=tools_root, secrets_dir=secrets, config=cfg)
    state = aw.WatchState(tmp_path / "watch.json")
    tool, store = await _local_app(dev, _ALICE, "notes", tools_root / "notes")

    # Another member cannot see alice's private app at all.
    with pytest.raises(KeyError):
        await aw.archive_app(runtime, dev, _BOB, "notes", state=state)

    out = await aw.archive_app(runtime, dev, _ALICE, "notes", state=state)
    assert out["lifecycle_state"] == "archived" and out["database_suspended"] is True
    assert box.verbs() == ["stop:dev", "unroute:dev"]
    assert [v for v, m, s in box.db_specs] == ["suspend"]
    assert (await dev.get("notes")).status == "disabled"
    assert (await store.get_runtime(tool.id))["lifecycle_state"] == "archived"
    assert (await store.get_database(tool.id, "dev")).status == "suspended"
    with pytest.raises(aw.LifecycleConflict):
        await aw.archive_app(runtime, dev, _ALICE, "notes", state=state)

    box.calls.clear()
    out = await aw.restore_app(runtime, dev, _ALICE, "notes", state=state)
    assert (out["lifecycle_state"], out["from"], out["started"]) == ("active", "archived", True)
    assert box.verbs() == ["route:dev", "start:dev"]
    assert (await dev.get("notes")).status == "enabled"  # archive switched it off, restore back on
    assert (await store.get_database(tool.id, "dev")).status == "ready"
    with pytest.raises(aw.LifecycleConflict):
        await aw.restore_app(runtime, dev, _ALICE, "notes", state=state)

    # Purge is only for an archived app, and needs the name repeated.
    with pytest.raises(aw.LifecycleConflict, match="archive it"):
        await aw.purge_app(runtime, dev, _ALICE, "notes", confirm="notes", state=state)
    await aw.archive_app(runtime, dev, _ALICE, "notes", state=state)
    (secrets / rt.secret_ref("notes", "dev")).write_text("token")
    box.calls.clear()
    box.db_specs.clear()
    with pytest.raises(ValueError, match="repeating the tool name"):
        await aw.purge_app(runtime, dev, _ALICE, "notes", confirm="", other_registry=prod, state=state)
    assert box.calls == []
    out = await aw.purge_app(runtime, dev, _ALICE, "notes", confirm="notes",
                             other_registry=prod, state=state)
    assert (out["lifecycle_state"], out["backup_ref"], out["source_deleted"]) == ("purged", "bk_drop", True)
    assert box.verbs() == ["remove:dev"]
    assert box.db_specs == [("drop", "dev", {"confirm": "notes"})]
    assert not (tools_root / "notes").exists()
    assert not (secrets / rt.secret_ref("notes", "dev")).exists()
    assert (await store.get_database(tool.id, "dev")).status == "dropped"
    assert (await store.get_runtime(tool.id))["lifecycle_state"] == "purged"
    assert (await dev.get("notes")).status == "disabled"  # the tombstone row stays
    with pytest.raises(aw.LifecycleConflict):
        await aw.restore_app(runtime, dev, _ALICE, "notes", state=state)

    rows = await _fetch(postgres_dsn, "SELECT a.action, c.reversible, c.actor_user_id "
                        "FROM app_prod.changes c JOIN app_prod.approvals a ON a.id = c.approval_ref "
                        "WHERE a.target_ref = 'code:notes' ORDER BY c.ts")
    acts = [(r["action"], r["reversible"]) for r in rows]
    assert ("hermes tool archive notes", True) in acts and ("hermes tool restore notes", True) in acts
    assert acts[-1] == ("hermes tool purge notes", False)
    assert {r["actor_user_id"] for r in rows} == {"alice"}
    # Decision 9: no member approval was asked for in dev.
    assert await _fetch(postgres_dsn, "SELECT 1 FROM app_prod.approvals WHERE target_ref = 'tool:notes'") == []


@pytest.mark.asyncio
async def test_prod_lifecycle_records_the_confirmation_and_keeps_shared_source(
    postgres_dsn, tmp_path, monkeypatch, no_quota,
):
    await _reset(postgres_dsn)
    cfg = _config(postgres_dsn)
    box = LifecycleBox(postgres_dsn)
    monkeypatch.setattr(rt, "_default_runner", box)
    dev = ToolRegistry(get_store("supabase-app", "dev", config=cfg))
    prod = ToolRegistry(get_store("supabase-app", "prod", config=cfg))
    await dev.initialize()
    await prod.initialize()
    tools_root = tmp_path / "tools"
    runtime = rt.AppRuntime(tools_root=tools_root, secrets_dir=tmp_path / "s", config=cfg)
    state = aw.WatchState(tmp_path / "watch.json")
    repo = tools_root / "shop"
    await _local_app(dev, _ALICE, "shop", repo)
    ptool, pstore = await _local_app(prod, _ALICE, "shop", repo, mode="prod")
    await pstore.record_deployment(ptool.id, mode="prod", target="prod", source_sha="abc1234",
                                   actor_user_id="alice", ready_state="ready", approval_ref="apr_promo")

    # The owner may act on anyone's app.
    await aw.archive_app(runtime, prod, _OWNER, "shop", state=state)
    await aw.restore_app(runtime, prod, _ALICE, "shop", state=state)
    approvals = await _fetch(postgres_dsn, "SELECT action, actor FROM app_prod.approvals "
                             "WHERE target_ref = 'tool:shop' ORDER BY created_at")
    assert [(r["action"], r["actor"]) for r in approvals] == [
        ("tool.archive", "root"), ("tool.restore", "alice")]
    assert [v for v, m, s in box.db_specs] == ["suspend", "resume"]
    assert all(s.get("approval_ref", "").startswith("apr_") for _v, _m, s in box.db_specs)

    await aw.archive_app(runtime, prod, _ALICE, "shop", state=state)
    out = await aw.purge_app(runtime, prod, _ALICE, "shop", confirm="shop", other_registry=dev,
                             state=state)
    assert out["source_deleted"] is False and repo.is_dir()  # dev still uses it
    drop = [s for v, m, s in box.db_specs if v == "drop"][0]
    assert drop["confirm"] == "shop" and box.approval_seen[f"drop:{drop['approval_ref']}"]
