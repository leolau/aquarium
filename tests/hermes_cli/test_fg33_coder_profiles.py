"""FG-33 P8-2 item 2.9: coder profiles (§10, decision 15).

Invariants: build cards go to the tool's override, else the hosting default;
the versioned definitions install into real (isolated) Hermes profiles that
load as kanban-only CLI workers; no credential ever lands in a coder profile;
the override is authorised per §10 and recorded as a C5 change (real
Postgres).
"""

from __future__ import annotations

import asyncio
import shutil
import subprocess
import time
import uuid
from collections.abc import Iterator
from pathlib import Path

import pytest
import yaml

from hermes_cli import app_coder
from hermes_cli.access import Principal
from hermes_cli.app_coder import (
    EXTERNAL_CODER,
    INTERNAL_CODER,
    CoderProfileError,
    coder_profile_for,
    install_coder_profile,
    load_definition,
)
from hermes_cli.tools_registry import Tool

REPO = Path(__file__).resolve().parents[2]

_OWNER = Principal(user_id="root", display="Root", role="owner")
_ADMIN = Principal(user_id="ann", display="Ann", role="admin")
_ALICE = Principal(user_id="alice", display="Alice", role="member")
_BOB = Principal(user_id="bob", display="Bob", role="member")
_VIEWER = Principal(user_id="vic", display="Vic", role="viewer")


@pytest.fixture()
def profile_env(tmp_path, monkeypatch):
    """Profiles root under tmp (same isolation as tests/hermes_cli/test_profiles.py)."""
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    return tmp_path


def _tool(**fields) -> Tool:
    base = dict(
        id="t1", name="notes", kind="in_house", stack="nextjs-node", owner_user_id="alice",
        visibility="private:alice", mode="dev", status="disabled", mcp_endpoint_ref=None,
        web_url=None, config_json={},
    )
    base.update(fields)
    return Tool(**base)


# ── assignment ───────────────────────────────────────────────────────────────


@pytest.mark.parametrize("row,expected", [
    (_tool(hosting="local"), INTERNAL_CODER),
    (_tool(hosting="external"), EXTERNAL_CODER),
    (_tool(hosting=None, kind="external"), EXTERNAL_CODER),
    (_tool(hosting=None), INTERNAL_CODER),  # FG-07 legacy rows build locally
    ({"hosting": "external"}, EXTERNAL_CODER),
    ({"hosting": "local", "coder_profile": None}, INTERNAL_CODER),
])
def test_hosting_picks_the_default_coder(row, expected):
    assert coder_profile_for(row) == expected


def test_override_wins_over_hosting_and_is_canonical():
    assert coder_profile_for(_tool(hosting="local", coder_profile="frontend-pro")) == "frontend-pro"
    assert coder_profile_for({"hosting": "external", "coder_profile": "Jules"}) == "jules"
    # Never hand kanban an assignee it would refuse: junk falls back.
    assert coder_profile_for({"hosting": "external", "coder_profile": "../x"}) == EXTERNAL_CODER
    assert coder_profile_for({"hosting": "local", "coder_profile": "  "}) == INTERNAL_CODER


def test_default_assignees_are_valid_kanban_profiles():
    from hermes_cli.kanban_db import _canonical_assignee
    from hermes_cli.profiles import validate_profile_name

    for name in app_coder.CODER_PROFILES:
        validate_profile_name(name)
        assert _canonical_assignee(name) == name


# ── versioned definitions ────────────────────────────────────────────────────


@pytest.mark.parametrize("name", app_coder.CODER_PROFILES)
def test_definition_is_versioned_and_kanban_only(name):
    d = load_definition(name)
    assert d.path == REPO / "deploy" / "profiles" / name
    assert d.version and d.soul.strip() and d.skills
    cli = d.overlay["platform_toolsets"]["cli"]
    assert {"terminal", "file", "skills"} <= set(cli)
    # One unattended card: no fan-out, no questions, no channels of its own.
    assert not {"delegation", "clarify", "cronjob", "messaging", "discord"} & set(cli)
    assert not {"platforms", "gateway", "mcp_servers"} & set(d.overlay)
    # Commands run as the agent's sandboxed user (decision 19).
    assert d.overlay["terminal"]["run_as"] == "hermes-tools"


def test_external_coder_has_the_internal_coding_skills():
    internal, external = load_definition(INTERNAL_CODER), load_definition(EXTERNAL_CODER)
    assert set(internal.skills) <= set(external.skills)
    # Skills that need a raw provider token are not coder skills.
    assert "software-development/railway-cli" not in external.skills


@pytest.mark.parametrize("name", app_coder.CODER_PROFILES)
def test_definition_files_hold_no_credentials(name):
    base = REPO / "deploy" / "profiles" / name
    assert {p.name for p in base.iterdir()} <= app_coder.DEFINITION_FILES
    for path in base.iterdir():
        text = path.read_text(encoding="utf-8")
        for line in text.splitlines():
            key = line.split("=", 1)[0].strip()
            assert not ("=" in line and app_coder._PROVIDER_ENV.match(key)), (path, key)


def _copy_def(tmp_path: Path, name: str = INTERNAL_CODER) -> Path:
    root = tmp_path / "defs"
    shutil.copytree(REPO / "deploy" / "profiles" / name, root / name)
    return root


@pytest.mark.parametrize("mutate,match", [
    (lambda d: (d / "config.yaml").write_text("model:\n  api_key: sk-live-123\n"), "credentials"),
    (lambda d: (d / "config.yaml").write_text("providers:\n  vercel:\n    token: abc\n"), "credentials"),
    (lambda d: (d / "config.yaml").write_text("platforms:\n  telegram:\n    enabled: true\n"), "kanban worker"),
    (lambda d: (d / ".env").write_text("VERCEL_TOKEN=abc\n"), "unexpected files"),
    (lambda d: (d / "auth.json").write_text("{}"), "unexpected files"),
    (lambda d: (d / "skills").mkdir(), "unexpected files"),
    (lambda d: (d / "profile.yaml").write_text(
        "name: internal-coder\nversion: 1.0.0\nskills: [../../etc]\n"), "Invalid skill path"),
    (lambda d: (d / "profile.yaml").write_text("name: other\nversion: 1.0.0\n"), "name"),
    (lambda d: (d / "profile.yaml").write_text("name: internal-coder\n"), "version"),
])
def test_unsafe_definitions_are_refused(tmp_path, mutate, match):
    root = _copy_def(tmp_path)
    mutate(root / INTERNAL_CODER)
    with pytest.raises(CoderProfileError, match=match):
        load_definition(INTERNAL_CODER, root=root)


# ── installation into real profiles ──────────────────────────────────────────


def test_install_creates_both_profiles_as_kanban_cli_workers(profile_env):
    from hermes_cli.profiles import get_profile_dir, list_profiles
    from hermes_cli.tools_config import _get_platform_tools

    lines: list[str] = []
    for name in app_coder.CODER_PROFILES:
        install_coder_profile(name, report=lines.append)
    assert {p.name for p in list_profiles()} >= set(app_coder.CODER_PROFILES)
    for name in app_coder.CODER_PROFILES:
        pdir = get_profile_dir(name)
        assert (pdir / "SOUL.md").read_text() == load_definition(name).soul
        config = yaml.safe_load((pdir / "config.yaml").read_text())
        tools = _get_platform_tools(config, "cli")
        assert {"terminal", "file", "skills"} <= tools
        assert "delegation" not in tools and "clarify" not in tools
        assert (pdir / "skills" / "software-development" / "test-driven-development" / "SKILL.md").is_file()
        marker = yaml.safe_load((pdir / app_coder.INSTALLED_MARKER).read_text())
        assert marker["version"] == load_definition(name).version
        assert app_coder.provider_credentials_in(pdir) == []
        # No wrapper alias / channel: the profile is only a kanban assignee.
        assert not (profile_env / ".local" / "bin" / name).exists()
    # A skill another item has not landed yet is reported, not fatal.
    if not (REPO / "skills" / "software-development" / "vibe-code-app").exists():
        assert any("vibe-code-app" in line for line in lines)


def test_reinstall_keeps_user_state_and_refreshes_the_definition(profile_env):
    from hermes_cli.profiles import get_profile_dir

    pdir = install_coder_profile(INTERNAL_CODER, report=lambda _: None)
    config = yaml.safe_load((pdir / "config.yaml").read_text())
    config["model"] = {"default": "some/model"}
    config["platform_toolsets"]["cli"] = ["terminal"]
    (pdir / "config.yaml").write_text(yaml.safe_dump(config))
    (pdir / "SOUL.md").write_text("drifted")
    (pdir / ".env").write_text("OPENROUTER_BASE_URL=https://example.invalid\n")
    (pdir / "memories").mkdir(exist_ok=True)
    (pdir / "memories" / "MEMORY.md").write_text("learned")

    assert install_coder_profile(INTERNAL_CODER, report=lambda _: None) == pdir == get_profile_dir(INTERNAL_CODER)
    config = yaml.safe_load((pdir / "config.yaml").read_text())
    assert config["model"] == {"default": "some/model"}
    assert config["platform_toolsets"]["cli"] == load_definition(INTERNAL_CODER).overlay["platform_toolsets"]["cli"]
    assert (pdir / "SOUL.md").read_text() == load_definition(INTERNAL_CODER).soul
    assert (pdir / ".env").read_text() == "OPENROUTER_BASE_URL=https://example.invalid\n"
    assert (pdir / "memories" / "MEMORY.md").read_text() == "learned"


@pytest.mark.parametrize("line", [
    "VERCEL_TOKEN=abc", "export RAILWAY_API_TOKEN=abc", "AWS_SECRET_ACCESS_KEY=abc",
    "SUPABASE_ACCESS_TOKEN=abc", "ALIBABA_CLOUD_ACCESS_KEY_ID=abc", "GITHUB_TOKEN=abc",
])
def test_install_refuses_a_profile_holding_provider_credentials(profile_env, line):
    pdir = install_coder_profile(EXTERNAL_CODER, report=lambda _: None)
    (pdir / ".env").write_text(f"# comment\n{line}\n")
    soul_before = (pdir / "SOUL.md").read_text()
    (pdir / "SOUL.md").write_text("untouched")
    with pytest.raises(CoderProfileError, match="provider credentials") as info:
        install_coder_profile(EXTERNAL_CODER, report=lambda _: None)
    assert "abc" not in str(info.value)  # names only, never values
    assert (pdir / "SOUL.md").read_text() == "untouched" != soul_before


def test_cli_check_and_install(profile_env, capsys):
    assert app_coder.main(["check"]) == 0
    assert app_coder.main(["install", INTERNAL_CODER]) == 0
    from hermes_cli.profiles import profile_exists

    assert profile_exists(INTERNAL_CODER) and not profile_exists(EXTERNAL_CODER)
    with pytest.raises(SystemExit):
        app_coder.main(["install", "default"])


# ── set_coder_profile against a real Postgres ────────────────────────────────

_PGVECTOR_IMAGE = (
    "pgvector/pgvector@sha256:"
    "1d533553fefe4f12e5d80c7b80622ba0c382abb5758856f52983d8789179f0fb"
)


async def _probe(dsn: str) -> None:
    import asyncpg

    conn = await asyncpg.connect(dsn, ssl=False)
    await conn.close()


@pytest.fixture(scope="module")
def postgres_dsn() -> Iterator[str]:
    import asyncpg

    if shutil.which("docker") is None:
        pytest.skip("Docker is required for the coder-profile registry test")
    if subprocess.run(["docker", "info"], check=False, capture_output=True).returncode != 0:
        pytest.skip("Docker daemon is unavailable for the coder-profile registry test")
    subprocess.run(["docker", "pull", _PGVECTOR_IMAGE], check=True, capture_output=True)
    container = f"hermes-fg33-coder-{uuid.uuid4().hex[:12]}"
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


@pytest.mark.asyncio
async def test_set_coder_profile_authorises_validates_and_records(postgres_dsn, profile_env):
    import asyncpg

    from hermes_cli.datastore import get_store, initialize_supabase_app
    from hermes_cli.profiles import create_profile
    from hermes_cli.tools_registry import ToolRegistry

    conn = await asyncpg.connect(postgres_dsn, ssl=False)
    try:
        await conn.execute("DROP SCHEMA IF EXISTS app_dev CASCADE; DROP SCHEMA IF EXISTS app_prod CASCADE;")
        await initialize_supabase_app(conn)
    finally:
        await conn.close()
    cfg = {"datastore": {"supabase_app": {"dsn": postgres_dsn}}}
    dev = ToolRegistry(get_store("supabase-app", "dev", config=cfg))
    prod_store = get_store("supabase-app", "prod", config=cfg)
    await dev.initialize()
    for name in (*app_coder.CODER_PROFILES, "frontend-pro"):
        create_profile(name, no_alias=True, no_skills=True, verify_datastore=False)

    await dev.create(_ALICE, "notes", "in_house", stack="nextjs-node", hosting="local")
    await dev.create(_BOB, "site", "external", stack="nextjs-node", hosting="external",
                     visibility="shared")

    async def set_(name, profile, who):
        return await app_coder.set_coder_profile(
            name, profile, principal=who, registry=dev, prod_store=prod_store,
        )

    assert coder_profile_for(await dev.get("notes")) == INTERNAL_CODER
    # The author of a private tool may set it, to an existing profile only.
    tool = await set_("notes", "Frontend-Pro", _ALICE)
    assert tool.coder_profile == "frontend-pro"
    assert coder_profile_for(await dev.get("notes")) == "frontend-pro"
    with pytest.raises(ValueError, match="No profile named"):
        await set_("notes", "ghost", _ALICE)
    with pytest.raises(ValueError):
        await set_("notes", "../etc", _ALICE)
    # Another member, a viewer: no.
    for who in (_BOB, _VIEWER):
        with pytest.raises(PermissionError):
            await set_("notes", EXTERNAL_CODER, who)
    # Shared tool: owner/admin only, even for its author.
    with pytest.raises(PermissionError, match="owner/admin"):
        await set_("site", INTERNAL_CODER, _BOB)
    assert (await set_("site", INTERNAL_CODER, _ADMIN)).coder_profile == INTERNAL_CODER
    assert (await set_("notes", EXTERNAL_CODER, _OWNER)).coder_profile == EXTERNAL_CODER
    # Clearing restores the hosting default.
    assert (await set_("site", None, _OWNER)).coder_profile is None
    assert coder_profile_for(await dev.get("site")) == EXTERNAL_CODER
    with pytest.raises(KeyError):
        await set_("nope", INTERNAL_CODER, _OWNER)

    from hermes_cli.changes import ChangeLog

    events = [
        e for e in reversed(await ChangeLog(prod_store).list_changes(_OWNER))
        if e.op and str(e.op[0].get("path", "")).endswith("/coder_profile")
    ]
    assert [(e.actor_user_id, e.op[0]["path"], e.mode) for e in events] == [
        ("alice", "/tools/notes/coder_profile", "dev"),
        ("ann", "/tools/site/coder_profile", "dev"),
        ("root", "/tools/notes/coder_profile", "dev"),
        ("root", "/tools/site/coder_profile", "dev"),
    ]
    last = events[-1]
    assert last.reversible and last.inverse_op[0]["value"] == INTERNAL_CODER
    assert last.payload == {"coder_profile": None, "previous": INTERNAL_CODER,
                            "resolved": EXTERNAL_CODER}
