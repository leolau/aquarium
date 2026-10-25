"""FG-33 P8-1 item 1.4: the local app runtime layer, CLI verbs and API routes.

The root helpers (``aquarium-app-helper``, ``aquarium apps db``) are replaced by
a fake runner at the ``HelperClient`` seam, so the tests check the exact argv
and JSON specs the sudoers rules must allow, and drive the real registry,
runtime tables, C5/C6 rows and promotion against a throwaway Postgres.
"""

from __future__ import annotations

import asyncio
import importlib.machinery
import importlib.util
import json
import shutil
import subprocess
import sys
import time
import uuid
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace

import asyncpg
import pytest

from hermes_cli import app_runtime as rt
from hermes_cli.access import Principal
from hermes_cli.app_store import AppStore
from hermes_cli.datastore import get_store, initialize_supabase_app
from hermes_cli.tools_registry import ToolRegistry, promote_tool

REPO = Path(__file__).resolve().parents[2]
_PGVECTOR_IMAGE = (
    "pgvector/pgvector@sha256:"
    "1d533553fefe4f12e5d80c7b80622ba0c382abb5758856f52983d8789179f0fb"
)

_OWNER = Principal(user_id="root", display="Root", role="owner")
_ADMIN = Principal(user_id="ann", display="Ann", role="admin")
_ALICE = Principal(user_id="alice", display="Alice", role="member")
_BOB = Principal(user_id="bob", display="Bob", role="member")
_VIEWER = Principal(user_id="vic", display="Vic", role="viewer")


@pytest.fixture
def no_quota(monkeypatch):
    """Admission off (as before item 1.6 lands); quota tests stub it themselves."""
    import hermes_cli

    monkeypatch.setitem(sys.modules, "hermes_cli.app_quota", None)
    monkeypatch.delattr(hermes_cli, "app_quota", raising=False)


# ── fake root helpers ─────────────────────────────────────────────────────────

class FakeBox:
    """Answers like the helpers would and records every call."""

    PORTS = {"dev": 4501, "prod": 4301}

    def __init__(self, dsn: str | None = None) -> None:
        self.calls: list[tuple[list[str], dict | None]] = []
        self.dsn = dsn
        self.approval_seen: dict[str, bool] = {}
        self.instances: list[dict] = []
        self.fail: dict[str, str] = {}
        self.secrets: dict[tuple, str] = {}
        self.db_specs: list[tuple[str, str, dict]] = []

    def __call__(self, argv, stdin, timeout):
        spec = json.loads(stdin) if stdin else None
        self.calls.append((list(argv), spec))
        if argv[:2] != ["sudo", "-n"]:
            return 1, "", "not via sudo -n"
        if argv[2] == rt.HELPER:
            return self._helper(argv[3], spec)
        if argv[2] == rt.PROVISIONER and argv[3:5] == ["apps", "db"] and len(argv) == 8:
            return self._db(argv[5], argv[6], argv[7], spec or {})
        return 1, "", "unknown program"

    def _helper(self, verb, spec):
        if verb in self.fail:
            return 3, "", self.fail[verb]
        if verb == "set-secret":
            self.secrets[(spec["slug"], spec["mode"], spec["name"])] = spec["value"]
            return 0, json.dumps({"slug": spec["slug"], "mode": spec["mode"]}), ""
        if verb == "build":
            return 0, json.dumps({"slug": spec["slug"], "mode": spec["mode"], "built": True,
                                  "release": f"{spec['mode']}-{spec['sha']}"}), ""
        if verb == "status" and spec.get("all"):
            return 0, json.dumps({"instances": self.instances, "problems": []}), ""
        if verb in ("allocate", "start", "restart", "status"):
            return 0, json.dumps({"slug": spec["slug"], "mode": spec["mode"],
                                  "port": self.PORTS[spec["mode"]], "active_state": "active",
                                  "sub_state": "running"}), ""
        if verb == "logs":
            return 0, json.dumps({"slug": spec["slug"], "mode": spec["mode"],
                                  "lines": "\n".join(f"line {i}" for i in range(spec["lines"]))}), ""
        return 0, json.dumps({"slug": spec["slug"], "mode": spec["mode"]}), ""

    def _db(self, verb, slug, mode, spec):
        self.db_specs.append((verb, mode, spec))
        if mode == "prod" and verb in ("create", "migrate", "drop"):
            ref = spec.get("approval_ref")
            if not ref:
                return 1, json.dumps({"ok": False, "error": "needs an approved approval_ref"}), ""
            self.approval_seen[f"{verb}:{ref}"] = asyncio.run(self._approved(ref))
        name = rt.app_db_name(slug, mode)
        if verb == "drop" and spec.get("confirm") != slug:
            return 1, json.dumps({"ok": False, "error": "confirmation missing"}), ""
        if verb == "migrate":
            return 0, json.dumps({"ok": True, "database": name, "backup_ref": f"bk_{mode}",
                                  "applied": [m["name"] for m in spec.get("migrations", [])]}), ""
        if verb == "drop":
            return 0, json.dumps({"ok": True, "database": name, "backup_ref": "bk_drop"}), ""
        if verb == "status":
            return 0, json.dumps({"ok": True, "database": name, "size_mb": 3,
                                  "dsn": "postgres://secret"}), ""
        return 0, json.dumps({"ok": True, "database": name}), ""

    async def _approved(self, ref: str) -> bool:
        if self.dsn is None:
            return False
        conn = await asyncpg.connect(self.dsn, ssl=False)
        try:
            return bool(await conn.fetchval(
                "SELECT 1 FROM app_prod.approvals WHERE id = $1 AND decision = 'approved'", ref,
            ))
        finally:
            await conn.close()

    def verbs(self, program: str = rt.HELPER) -> list[str]:
        out = []
        for argv, spec in self.calls:
            if argv[2] == program:
                out.append(f"{argv[3]}:{spec['mode']}" if program == rt.HELPER and spec and "mode" in spec
                           else " ".join(argv[3:]))
        return out


# ── HelperClient: argv + spec validation (no box needed) ──────────────────────

def test_helper_argv_is_exact_and_specs_are_validated():
    box = FakeBox()
    client = rt.HelperClient(box)
    assert client.helper_argv("build") == ["sudo", "-n", "/usr/local/sbin/aquarium-app-helper", "build"]
    assert client.db_argv("migrate", "notes", "prod") == [
        "sudo", "-n", "/usr/local/sbin/aquarium", "apps", "db", "migrate", "notes", "prod",
    ]
    assert json.loads(client.db_spec("migrate", "notes", "prod", approval_ref="apr_1",
                                      migrations=[{"name": "1_init.sql", "sql": "select 1"}])) == {
        "approval_ref": "apr_1", "migrations": [{"name": "1_init.sql", "sql": "select 1"}]}
    assert client.db_spec("create", "notes", "dev") is None
    with pytest.raises(ValueError):
        client.db_spec("drop", "notes", "dev", confirm="other")
    for bad in ("../etc", "Notes", "a/b", "-x", "", "a" * 41, "trailing-"):
        with pytest.raises(ValueError):
            client.call("start", slug=bad, mode="dev")
        with pytest.raises(ValueError):
            client.db_argv("create", bad, "dev")
    with pytest.raises(ValueError):
        client.call("shell", slug="notes", mode="dev")
    with pytest.raises(ValueError):
        client.call("start", slug="notes", mode="staging")
    with pytest.raises(ValueError):
        client.call("start", slug="notes", mode="dev", path="/etc/shadow")
    with pytest.raises(ValueError):
        client.call("build", slug="notes", mode="dev", sha="HEAD; rm -rf /")
    with pytest.raises(ValueError):  # the helper refuses unknown fields; so do we
        client.call("start", slug="notes", mode="dev", approval_ref="apr_1")
    with pytest.raises(ValueError):
        client.call("remove", slug="notes", mode="dev", confirm="other")
    with pytest.raises(ValueError):
        client.call("set-secret", slug="notes", mode="dev", name="../x", value="v")
    with pytest.raises(PermissionError):
        client.call("build", slug="notes", mode="prod", sha="a" * 40)
    for verb in ("create", "migrate", "drop", "suspend", "resume"):
        with pytest.raises(PermissionError):
            client.db_spec(verb, "notes", "prod", confirm="notes")
    assert box.calls == []  # nothing invalid reached sudo

    out = client.call("logs", slug="notes", mode="dev", lines=10_000)
    assert box.calls[-1][1] == {"slug": "notes", "mode": "dev", "lines": rt.MAX_LOG_LINES}
    assert out["lines"].count("\n") == rt.MAX_LOG_LINES - 1
    box2 = FakeBox()
    with pytest.raises(rt.HelperError, match="approval_ref"):  # ok:false is an error
        def refuse(argv, stdin, timeout):
            return 1, json.dumps({"ok": False, "error": "needs an approved approval_ref"}), ""
        rt.HelperClient(refuse).db("migrate", "notes", "prod", approval_ref="apr_1")
    assert box2.calls == []


def test_helper_failures_surface_as_helper_errors():
    def missing(argv, stdin, timeout):
        return 127, "", "No such file"

    with pytest.raises(rt.HelperError, match="not installed"):
        rt.HelperClient(missing).call("status", slug="notes", mode="dev")
    box = FakeBox()
    box.fail["build"] = "npm ci: lockfile missing"
    with pytest.raises(rt.HelperError, match="lockfile missing"):
        rt.HelperClient(box).call("build", slug="notes", mode="dev", sha="a" * 40)


def test_paths_names_and_admission(monkeypatch):
    assert rt.app_path("notes", "prod") == "/apps/notes"
    assert rt.app_path("notes", "dev") == "/apps-dev/notes"
    assert rt.app_db_name("notes", "dev") != rt.app_db_name("notes", "prod")
    assert rt.app_db_name("my-app", "dev").startswith("lapp_my_app_")
    assert rt.endpoint_name("notes") == "la-notes"

    monkeypatch.delitem(sys.modules, "hermes_cli.app_quota", raising=False)
    import hermes_cli

    monkeypatch.delattr(hermes_cli, "app_quota", raising=False)
    fake = SimpleNamespace(verdict="ok")
    quota = SimpleNamespace(check_admission=lambda principal, action, **kw: fake)
    monkeypatch.setitem(sys.modules, "hermes_cli.app_quota", quota)
    rt.check_admission(_ALICE, "build")
    fake.verdict, fake.reason = "refused", "per-member running apps (2/2)"
    with pytest.raises(rt.AdmissionRefused, match=r"running apps \(2/2\)"):
        rt.check_admission(_ALICE, "start")
    quota.check_admission = lambda principal, action, **kw: ("needs_approval", "")
    with pytest.raises(rt.AdmissionRefused) as info:
        rt.check_admission(_ALICE, "create")
    assert info.value.needs_approval


# ── hermes-tools-cli allowlist: enum flags, never paths ───────────────────────

def _cli():
    loader = importlib.machinery.SourceFileLoader("hermes_tools_cli_fg33", str(REPO / "deploy/hermes-tools-cli"))
    spec = importlib.util.spec_from_loader("hermes_tools_cli_fg33", loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


@pytest.mark.parametrize("argv,path", [
    (["tool", "new", "notes", "--template", "nextjs-supabase", "--hosting", "local"], ["tool", "new"]),
    (["tool", "new", "site", "--hosting=external", "--provider=vercel"], ["tool", "new"]),
    (["tool", "build", "notes", "--mode", "dev"], ["tool", "build"]),
    (["tool", "--mode", "prod", "restart", "notes"], ["tool", "restart"]),
    (["tool", "logs", "notes", "--lines", "50"], ["tool", "logs"]),
    (["tool", "status", "notes"], ["tool", "status"]),
    (["tool", "preview", "notes", "--mode=prod"], ["tool", "preview"]),
    (["tool", "doctor", "--json"], ["tool", "doctor"]),
    (["tool", "stop", "notes"], ["tool", "stop"]),
])
def test_cli_allows_the_app_verbs(argv, path):
    assert _cli().check(argv) == path


@pytest.mark.parametrize("argv", [
    ["tool", "new", "x", "--hosting", "/tmp/evil"],
    ["tool", "new", "x", "--template=../../etc"],
    ["tool", "new", "x", "--provider", "aws"],
    ["tool", "new", "x", "--root", "/tmp"],
    ["tool", "--mode", "staging", "list"],
    ["tool", "build", "x", "--mode", "../prod"],
    ["tool", "logs", "x", "--lines", "1;id"],
    ["tool", "delete", "x"],
    ["tool", "archive", "x"],
    ["tool", "doctor", "--fix"],
])
def test_cli_refuses_non_enum_values_and_destructive_verbs(argv):
    cli = _cli()
    with pytest.raises(cli.Refused):
        cli.check(argv)


def test_cli_verbs_parse_with_mode_after_the_verb():
    import argparse

    from hermes_cli.tool_cmd import register_tool_subparser

    parser = argparse.ArgumentParser()
    register_tool_subparser(parser.add_subparsers())
    args = parser.parse_args(["tool", "build", "notes", "--mode", "prod"])
    assert (args.tool_action, args.name, args.mode) == ("build", "notes", "prod")
    args = parser.parse_args(["tool", "--mode", "dev", "logs", "notes", "--lines", "5"])
    assert (args.tool_action, args.mode, args.lines) == ("logs", "dev", 5)
    args = parser.parse_args(["tool", "new", "notes", "--template", "nextjs-supabase",
                              "--hosting", "local"])
    assert (args.template, args.hosting, args.provider) == ("nextjs-supabase", "local", None)
    with pytest.raises(SystemExit):
        parser.parse_args(["tool", "new", "x", "--hosting", "moon"])


# ── API routes: caller, C2 and error mapping ─────────────────────────────────

@pytest.fixture
def api(monkeypatch):
    from starlette.testclient import TestClient

    import hermes_cli.datastore as datastore
    import hermes_cli.tools_registry as tools_registry
    from hermes_cli import web_server

    seen: dict = {}
    who = {"as": _ALICE}

    async def caller(request, *, allow_as=False):
        return who["as"]

    class Registry:
        def __init__(self, store):
            self.mode = store

        async def initialize(self):
            pass

    class Runtime:
        async def build(self, registry, principal, name):
            seen["build"] = (principal.user_id, registry.mode, name)
            if name == "missing":
                raise KeyError(name)
            if name == "broken":
                raise rt.HelperError("aquarium-app-helper build failed: npm ci")
            if name == "full":
                raise rt.AdmissionRefused("per-member running apps (2/2)")
            return {"tool": name}

        async def control(self, registry, principal, name, verb):
            seen["control"] = (principal.user_id, registry.mode, verb)
            if registry.mode == "prod" and principal.role == "member":
                raise PermissionError("no approved prod release")
            return {"tool": name, "runtime_state": "running"}

        async def logs(self, registry, principal, name, *, lines):
            seen["logs"] = lines
            return {"lines": "ok"}

        async def runtime(self, registry, principal, name):
            return {"tool": name, "mode": registry.mode}

        async def database(self, registry, principal, name):
            return {"database": None}

        async def remove(self, registry, principal, name, *, confirm):
            if confirm != name:
                raise ValueError("confirm by passing the tool name")
            seen["remove"] = (principal.user_id, registry.mode)
            return {"removed": True}

    monkeypatch.setattr(web_server, "_comms_resolve_principal", caller)
    monkeypatch.setattr(web_server, "_comms_session_subject", lambda request: who["as"].user_id)
    monkeypatch.setattr(datastore, "get_store", lambda kind, mode, **k: mode)
    monkeypatch.setattr(tools_registry, "ToolRegistry", Registry)
    monkeypatch.setattr(rt, "AppRuntime", Runtime)
    # Other suites may leave a bound host behind (DNS-rebinding guard).
    monkeypatch.setattr(web_server.app.state, "bound_host", None, raising=False)
    client = TestClient(web_server.app, raise_server_exceptions=False)
    client.headers[web_server._SESSION_HEADER_NAME] = web_server._SESSION_TOKEN
    return client, seen, who


def test_app_routes_act_as_the_caller_and_map_errors(api):
    client, seen, who = api
    assert client.post("/api/tools/notes/build", json={}).status_code == 200
    assert seen["build"] == ("alice", "dev", "notes")  # a member, default dev
    assert client.post("/api/tools/missing/build", json={}).status_code == 404
    assert client.post("/api/tools/broken/build", json={}).status_code == 502
    refused = client.post("/api/tools/full/build", json={})
    assert refused.status_code == 409 and "2/2" in refused.json()["detail"]
    assert client.post("/api/tools/notes/restart", json={"mode": "prod"}).status_code == 403
    who["as"] = _ADMIN
    assert client.post("/api/tools/notes/restart", json={"mode": "prod"}).status_code == 200
    assert seen["control"] == ("ann", "prod", "restart")
    assert client.get("/api/tools/notes/logs?lines=7").json() == {"lines": "ok"}
    assert seen["logs"] == 7
    assert client.get("/api/tools/notes/runtime?mode=prod").json()["mode"] == "prod"
    assert client.get("/api/tools/notes/database").status_code == 200
    assert client.delete("/api/tools/notes").status_code == 400
    assert client.delete("/api/tools/notes?confirm=notes&mode=dev").status_code == 200
    assert seen["remove"] == ("ann", "dev")


# ── E2E against a throwaway Postgres ─────────────────────────────────────────

async def _probe(dsn: str) -> None:
    conn = await asyncpg.connect(dsn, ssl=False)
    await conn.close()


@pytest.fixture(scope="module")
def postgres_dsn() -> Iterator[str]:
    if shutil.which("docker") is None:
        pytest.skip("Docker is required for the FG-33 local app E2E test")
    if subprocess.run(["docker", "info"], check=False, capture_output=True).returncode != 0:
        pytest.skip("Docker daemon is unavailable for the FG-33 local app E2E test")
    subprocess.run(["docker", "pull", _PGVECTOR_IMAGE], check=True, capture_output=True)
    container = f"hermes-fg33-{uuid.uuid4().hex[:12]}"
    subprocess.run(
        ["docker", "run", "--detach", "--rm", "--name", container,
         "--env", "POSTGRES_PASSWORD=hermes-test", "--env", "POSTGRES_DB=hermes_test",
         "--publish", "127.0.0.1::5432", _PGVECTOR_IMAGE],
        check=True, capture_output=True, text=True,
    )
    try:
        port = subprocess.run(
            ["docker", "port", container, "5432/tcp"], check=True, capture_output=True, text=True,
        ).stdout.strip().splitlines()[0].rsplit(":", 1)[1]
        dsn = f"postgresql://postgres:hermes-test@127.0.0.1:{port}/hermes_test"
        for _ in range(80):
            try:
                asyncio.run(_probe(dsn))
                break
            except (OSError, asyncpg.PostgresError):
                time.sleep(0.25)
        else:
            raise RuntimeError("Throwaway Postgres did not become ready")
        yield dsn
    finally:
        subprocess.run(["docker", "rm", "--force", container], check=False, capture_output=True)


def _config(dsn: str) -> dict:
    return {"datastore": {"supabase_app": {"dsn": dsn}}}


async def _reset(dsn: str) -> None:
    conn = await asyncpg.connect(dsn, ssl=False)
    try:
        await conn.execute("DROP SCHEMA IF EXISTS app_dev CASCADE; DROP SCHEMA IF EXISTS app_prod CASCADE;")
        await initialize_supabase_app(conn)
    finally:
        await conn.close()


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), "-c", "user.email=t@example.com", "-c", "user.name=t", *args],
        check=True, capture_output=True, text=True,
    ).stdout.strip()


def _fake_scaffold(name, root, *, template="minimal", hosting="local", provider=None, port=None):
    project = Path(root) / name
    project.mkdir(parents=True, exist_ok=True)
    (project / "tool.config.json").write_text(json.dumps(
        {"name": name, "stack": "nextjs-node", "hosting": hosting, "template_version": 1}))
    (project / "supabase" / "migrations").mkdir(parents=True, exist_ok=True)
    (project / "supabase" / "migrations" / "20261025000000_init.sql").write_text("create table notes(id int);")
    subprocess.run(["git", "init", "-q", "-b", "main", str(project)], check=True)
    _git(project, "add", "-A")
    _git(project, "commit", "-qm", "scaffold")
    _git(project, "branch", "dev")
    _git(project, "checkout", "-q", "dev")
    return SimpleNamespace(root=project, port=port, files=["tool.config.json"])


async def _fetch(dsn: str, sql: str, *args):
    conn = await asyncpg.connect(dsn, ssl=False)
    try:
        return await conn.fetch(sql, *args)
    finally:
        await conn.close()


@pytest.mark.asyncio
async def test_local_app_scaffold_build_promote_undo_and_remove(
    postgres_dsn, tmp_path, monkeypatch, no_quota,
):
    await _reset(postgres_dsn)
    cfg = _config(postgres_dsn)
    home = tmp_path / "home"
    monkeypatch.setenv("HERMES_HOME", str(home))
    box = FakeBox(postgres_dsn)
    monkeypatch.setattr(rt, "_default_runner", box)
    import hermes_cli.tool_scaffold as tool_scaffold
    from hermes_cli import tool_cmd

    monkeypatch.setattr(tool_scaffold, "scaffold_in_house_tool", _fake_scaffold)
    dev = ToolRegistry(get_store("supabase-app", "dev", config=cfg))
    prod = ToolRegistry(get_store("supabase-app", "prod", config=cfg))
    prod_store = get_store("supabase-app", "prod", config=cfg)
    await dev.initialize()
    await prod.initialize()

    # tool new --template nextjs-supabase --hosting local, as alice.
    args = SimpleNamespace(name="notes", template="nextjs-supabase", hosting="local",
                           provider=None, shared=False, root=str(tmp_path / "tools"))
    await tool_cmd._cmd_new_app(args, _ALICE, dev, prod_store, "dev")
    tool = await dev.get("notes")
    assert (tool.owner_user_id, tool.hosting, tool.kind, tool.status, tool.build_state) == (
        "alice", "local", "in_house", "disabled", "draft")
    assert tool.mcp_endpoint_ref == "la-notes"
    assert tool.config_json["app"]["hosting"] == "local"
    token = home / "auth" / "mcp-secrets" / "la-notes-dev"
    assert token.stat().st_mode & 0o777 == 0o600 and len(token.read_text()) >= 32
    assert box.secrets[("notes", "dev", "APP_MCP_TOKEN")] == token.read_text()
    endpoint = (await _fetch(postgres_dsn, "SELECT * FROM app_dev.mcp_endpoints WHERE name='la-notes'"))[0]
    transport = json.loads(endpoint["transport"])
    assert transport["url"] == "http://127.0.0.1:4501/apps-dev/notes/api/mcp"
    assert transport["auth"] == "bearer"
    assert (endpoint["app_kind"], endpoint["secret_ref"]) == ("local", "la-notes-dev")
    assert token.read_text() not in json.dumps(dict(endpoint), default=str)
    assert box.verbs() == ["allocate:dev", "set-secret:dev"]
    assert box.verbs(rt.PROVISIONER) == ["apps db create notes dev"]
    with pytest.raises(SystemExit):  # apps are never created in prod
        await tool_cmd._cmd_new_app(args, _ALICE, prod, prod_store, "prod")

    runtime = rt.AppRuntime(rt.HelperClient(box), config=cfg, secrets_dir=home / "auth" / "mcp-secrets")

    # C2: bob, a viewer and an admin cannot see or act on alice's private
    # app (only the owner bypasses scope).
    for who in (_BOB, _VIEWER, _ADMIN):
        with pytest.raises(KeyError):
            await runtime.build(dev, who, "notes")
        with pytest.raises(KeyError):
            await runtime.runtime(dev, who, "notes")
        with pytest.raises(KeyError):
            await runtime.logs(dev, who, "notes")
        with pytest.raises(KeyError):
            await runtime.remove(dev, who, "notes", confirm="notes")
    with pytest.raises(PermissionError):  # prod releases come from promote only
        await runtime.build(prod, _ALICE, "notes")

    # build (dev): release from the dev HEAD, instance restarted.
    sha1 = _git(Path(tool.repo_path), "rev-parse", "dev")
    built = await runtime.build(dev, _ALICE, "notes")
    assert built["release_sha"] == sha1 and built["path"] == "/apps-dev/notes"
    assert box.db_specs[-1] == ("migrate", "dev", {"migrations": [
        {"name": "20261025000000_init.sql", "sql": "create table notes(id int);"}]})
    tool = await dev.get("notes")
    assert (tool.build_state, tool.release_sha) == ("ready", sha1)
    state = await runtime.runtime(dev, _ALICE, "notes")
    assert state["runtime"]["runtime_state"] == "running"
    assert state["deployments"][0]["source_sha"] == sha1
    assert box.calls[-3][1] == {"slug": "notes", "mode": "dev", "sha": sha1}
    assert [a[3] for a, _ in box.calls[-2:]] == ["restart", "route"]  # served at /apps-dev/notes
    assert box.calls[-1][1] == {"slug": "notes", "mode": "dev"}
    assert (await runtime.status(dev, _ALICE, "notes"))["live"]["active_state"] == "active"
    assert (await runtime.logs(dev, _OWNER, "notes", lines=3))["lines"] == "line 0\nline 1\nline 2"
    db = await runtime.database(dev, _ALICE, "notes")
    assert db["database"]["db_name"] == rt.app_db_name("notes", "dev")
    assert "dsn" not in db["live"]

    # A failed build marks the row and the deployment, and is not hidden.
    box.fail["build"] = "npm audit: 1 critical"
    with pytest.raises(rt.HelperError):
        await runtime.build(dev, _ALICE, "notes")
    assert (await dev.get("notes")).build_state == "failed"
    del box.fail["build"]
    await runtime.build(dev, _ALICE, "notes")

    # prod start before any promotion is refused (no approval to act under).
    with pytest.raises(KeyError):
        await runtime.control(prod, _ALICE, "notes", "start")

    # promote: approval committed first, then the §3.7 plan, then the rows.
    result = await promote_tool(prod_store, "notes", actor="alice", approved=True, runtime=runtime)
    assert box.approval_seen == {f"create:{result.approval_ref}": True,
                                 f"migrate:{result.approval_ref}": True}
    prod_tool = await prod.get("notes")
    assert (prod_tool.status, prod_tool.release_sha, prod_tool.owner_user_id) == ("disabled", sha1, "alice")
    repo = Path(tool.repo_path)
    assert _git(repo, "rev-parse", "main") == sha1 and _git(repo, "rev-parse", "v1^{commit}") == sha1
    prod_ep = (await _fetch(postgres_dsn, "SELECT * FROM app_prod.mcp_endpoints WHERE name='la-notes'"))[0]
    assert json.loads(prod_ep["transport"])["url"] == "http://127.0.0.1:4301/apps/notes/api/mcp"
    assert (prod_ep["secret_ref"], prod_ep["enabled"]) == ("la-notes-prod", False)
    prod_token = (home / "auth" / "mcp-secrets" / "la-notes-prod").read_text()
    assert prod_token == box.secrets[("notes", "prod", "APP_MCP_TOKEN")] != token.read_text()
    dev_dbs = await _fetch(postgres_dsn, "SELECT db_name FROM app_dev.app_databases")
    prod_dbs = await _fetch(postgres_dsn, "SELECT db_name, last_backup_ref FROM app_prod.app_databases")
    assert {r["db_name"] for r in dev_dbs} != {r["db_name"] for r in prod_dbs}
    assert prod_dbs[0]["last_backup_ref"] == "bk_prod"
    prod_calls = [(a[3], s) for a, s in box.calls if a[2] == rt.HELPER and s and s.get("mode") == "prod"]
    assert [v for v, _ in prod_calls] == ["allocate", "set-secret", "build", "restart", "route"]
    assert prod_calls[2][1] == {"slug": "notes", "mode": "prod", "sha": sha1,
                                "approval_ref": result.approval_ref}
    change = (await _fetch(postgres_dsn, "SELECT op, inverse_op FROM app_prod.changes WHERE id=$1",
                           result.change_ref))[0]
    assert json.loads(change["inverse_op"]) == {"kind": "data", "table": "tools",
                                                "pk": {"name": "notes"}, "state": None}
    assert json.loads(change["op"])["state"]["release_sha"] == sha1

    # prod control now acts under the promotion's approval.
    assert (await runtime.control(prod, _ALICE, "notes", "restart"))["runtime_state"] == "running"
    assert box.calls[-1][1] == {"slug": "notes", "mode": "prod"}
    with pytest.raises(KeyError):
        await runtime.control(prod, _BOB, "notes", "stop")

    # Second release → v2; its change undoes through the FG-12 engine.
    (repo / "page.txt").write_text("v2")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "v2")
    sha2 = _git(repo, "rev-parse", "dev")
    second = await promote_tool(prod_store, "notes", actor="alice", approved=True, runtime=runtime)
    assert (await prod.get("notes")).release_sha == sha2
    assert _git(repo, "rev-parse", "v2^{commit}") == sha2
    assert f"create:{second.approval_ref}" not in box.approval_seen  # prod DB exists already
    from hermes_cli.changes import ChangeLog

    await ChangeLog(prod_store).undo(second.change_ref, _OWNER)
    assert (await prod.get("notes")).release_sha == sha1

    # doctor: owner sees an orphan instance; a member sees only their own app.
    box.instances = [{"slug": "notes", "mode": "dev", "active": True},
                     {"slug": "notes", "mode": "prod", "active": True},
                     {"slug": "ghost", "mode": "dev", "active": True}]
    report = await runtime.doctor({"dev": dev, "prod": prod}, _OWNER)
    assert report["problems"] == [{"kind": "orphan_instance", "tool": "ghost", "mode": "dev"}]
    assert (await runtime.doctor({"dev": dev, "prod": prod}, _ALICE))["ok"] is True

    # remove (dev): one explicit confirmation, then instance + database + rows.
    with pytest.raises(ValueError, match="confirm"):
        await runtime.remove(dev, _ALICE, "notes", confirm="yes")
    removed = await runtime.remove(dev, _ALICE, "notes", confirm="notes")
    assert removed["dropped_database"] == rt.app_db_name("notes", "dev")
    assert await dev.get("notes") is None
    assert not (home / "auth" / "mcp-secrets" / "la-notes-dev").exists()
    assert await _fetch(postgres_dsn, "SELECT 1 FROM app_dev.app_databases") == []
    assert await _fetch(postgres_dsn, "SELECT 1 FROM app_dev.mcp_endpoints WHERE name='la-notes'") == []
    assert "apps db drop notes dev" in box.verbs(rt.PROVISIONER)
    assert await prod.get("notes") is not None  # prod untouched

    # remove (prod) records its own approval before the irreversible drop.
    await runtime.remove(prod, _ALICE, "notes", confirm="notes")
    drop = [k for k in box.approval_seen if k.startswith("drop:")]
    assert len(drop) == 1 and box.approval_seen[drop[0]] is True
    assert await prod.get("notes") is None


@pytest.mark.asyncio
async def test_legacy_tool_promotion_inverse_is_engine_replayable(postgres_dsn):
    """Not only apps: every promotion's change is now undoable (was a 409)."""
    await _reset(postgres_dsn)
    cfg = _config(postgres_dsn)
    dev = ToolRegistry(get_store("supabase-app", "dev", config=cfg))
    prod = ToolRegistry(get_store("supabase-app", "prod", config=cfg))
    await dev.initialize()
    await prod.initialize()
    await dev.create(_OWNER, "billing", "in_house", visibility="shared")
    await dev.set_config(_OWNER, "billing", {"currency": "USD"})
    store = get_store("supabase-app", "prod", config=cfg)
    await promote_tool(store, "billing", actor="root", approved=True)
    await dev.set_config(_OWNER, "billing", {"currency": "EUR"})
    second = await promote_tool(store, "billing", actor="root", approved=True)
    assert (await prod.get("billing")).config_json == {"currency": "EUR"}
    from hermes_cli.changes import ChangeLog

    await ChangeLog(store).undo(second.change_ref, _OWNER)
    assert (await prod.get("billing")).config_json == {"currency": "USD"}
    await ChangeLog(store).redo(_OWNER, change_ref=second.change_ref)
    assert (await prod.get("billing")).config_json == {"currency": "EUR"}


@pytest.mark.asyncio
async def test_runtime_tables_have_no_secret_columns(postgres_dsn):
    await _reset(postgres_dsn)
    store = AppStore(get_store("supabase-app", "dev", config=_config(postgres_dsn)))
    await store.initialize()
    rows = await _fetch(
        postgres_dsn,
        "SELECT table_name, column_name FROM information_schema.columns "
        "WHERE table_schema='app_dev' AND table_name IN ('app_databases','app_deployments','tool_runtime')",
    )
    assert {r["table_name"] for r in rows} == {"app_databases", "app_deployments", "tool_runtime"}
    assert not [r for r in rows if any(w in r["column_name"] for w in ("dsn", "password", "token", "secret"))]


@pytest.mark.asyncio
async def test_quota_refusal_stops_build_before_any_helper_call(postgres_dsn, tmp_path, monkeypatch):
    """Item 1.6's pure ``check_admission(principal, action, *, usage, box, request)``."""
    await _reset(postgres_dsn)
    cfg = _config(postgres_dsn)
    dev = ToolRegistry(get_store("supabase-app", "dev", config=cfg))
    await dev.initialize()
    await dev.create(_ALICE, "notes", "in_house", hosting="local")
    await dev.create(_ALICE, "diary", "in_house", hosting="local")
    seen = {}

    def check(principal, action, *, usage, box, request=None):
        seen.update(action=action, registered=usage.registered, box=box.apps_registered,
                    tool=request.tool)
        return SimpleNamespace(verdict="refused", reason="box: apps slice memory 6144/6144 MB")

    quota = SimpleNamespace(
        check_admission=check,
        MemberUsage=lambda **kw: SimpleNamespace(**kw),
        AdmissionRequest=lambda **kw: SimpleNamespace(**kw),
        probe_box=lambda *, apps_registered: SimpleNamespace(apps_registered=apps_registered),
    )
    import hermes_cli

    monkeypatch.setitem(sys.modules, "hermes_cli.app_quota", quota)
    monkeypatch.setattr(hermes_cli, "app_quota", quota, raising=False)
    box = FakeBox()
    runtime = rt.AppRuntime(rt.HelperClient(box), config=cfg, tools_root=tmp_path)
    with pytest.raises(rt.AdmissionRefused, match="6144/6144"):
        await runtime.build(dev, _ALICE, "notes")
    assert seen == {"action": "build", "registered": frozenset({"notes", "diary"}),
                    "box": 2, "tool": "notes"}
    assert box.calls == []
    assert (await dev.get("notes")).build_state is None
