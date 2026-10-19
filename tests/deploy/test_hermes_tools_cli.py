"""deploy/hermes-tools-cli: the agent's `hermes ...` calls, run as hermes from an allowlist.

The allowlist checks run everywhere. The real path (passwordless sudo, Docker
and a checkout hermes can read, as on the Devin VM) runs deploy/hermes-tools-setup
on a temp HERMES_HOME, then a gateway-side Python process as ``hermes`` with
``terminal.run_as: hermes-tools`` drives the skills' commands through the real
shim, sudo rule and helper against a throwaway Postgres, and finally runs the
generated rollback.sh.
"""

from __future__ import annotations

import asyncio
import importlib.machinery
import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
CLI = REPO / "deploy/hermes-tools-cli"


def _load():
    loader = importlib.machinery.SourceFileLoader("hermes_tools_cli", str(CLI))
    spec = importlib.util.spec_from_loader("hermes_tools_cli", loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


cli = _load()


@pytest.mark.parametrize("argv,path", [
    (["tool", "new", "demo"], ["tool", "new"]),
    (["tool", "--mode", "dev", "new", "demo", "--shared"], ["tool", "new"]),
    (["tool", "config", "demo", "--json={\"a\": 1}"], ["tool", "config"]),
    (["promote", "tool:demo", "--approve", "--actor", "leo"], ["promote"]),
    (["owner", "transfer", "u1", "--approve"], ["owner", "transfer"]),
    (["cron", "list"], ["cron", "list"]),
    (["cron", "create", "0 9 * * *", "check the inbox", "--name", "daily"], ["cron", "create"]),
    (["kanban", "--board", "ops", "create", "Fix it", "--body", "details"], ["kanban", "create"]),
    (["kanban", "create", "Title", "--priority=-1"], ["kanban", "create"]),
    (["vpn", "status", "--json"], ["vpn", "status"]),
    (["skills", "install", "official/productivity/telephony", "--yes"], ["skills", "install"]),
    (["memory", "status"], ["memory", "status"]),
    (["tool", "new", "--help"], ["tool", "new"]),
])
def test_allowed(argv, path):
    assert cli.check(argv) == path


@pytest.mark.parametrize("argv", [
    [],
    ["config", "show"],
    ["config", "set", "security.terminal_database_credentials", "true"],
    ["auth", "list"],
    ["dashboard"],
    ["gateway", "run"],
    ["-p", "other", "tool", "list"],
    ["tool", "list", "-p", "other"],
    ["tool", "list", "--profile=other"],
    ["--ignore-user-config", "tool", "list"],
    ["tool", "--as", "someone", "list"],
    ["tool", "new", "x", "--root", "/tmp"],
    ["tool", "config", "demo", "--file", "/opt/data/hermes-home/.env"],
    ["tool", "config", "demo", "--fi", "/etc/shadow"],
    ["tool", "config", "demo", "--json"],
    ["tool", "config", "demo", "--json", "--file"],
    ["tool", "list", "--"],
    ["tool", "list", "--shared=1"],
    ["cron", "tick"],
    ["cron", "--accept-hooks", "run", "job1"],
    ["cron", "run", "job1", "--accept-hooks"],
    ["kanban", "daemon"],
    ["kanban", "create", "t", "--body", "-p"],
    ["skills", "install", "x", "--force"],
    ["owner", "init", "u1"],
    ["memory", "reset"],
    ["vpn", "migrate"],
    ["tool"],
    ["tool", "list", "x\x00y"],
])
def test_refused(argv):
    with pytest.raises(cli.Refused):
        cli.check(argv)


def test_rule_lets_hermes_tools_reach_the_cli_as_hermes_only():
    rule = (REPO / "deploy/sudoers.d/hermes-tools").read_text()
    assert "hermes-tools ALL=(hermes) NOPASSWD: /usr/local/sbin/hermes-tools-cli" in rule
    assert "hermes-tools ALL=(hermes) NOPASSWD:SETENV" not in rule
    assert "(root)" not in rule
    assert "PATH=/usr/local/lib/hermes-tools/bin:" in (REPO / "deploy/hermes-tools-exec").read_text()


def test_installer_and_deploy_ship_it():
    install = (REPO / "install-aquarium.sh").read_text()
    assert "bash deploy/hermes-tools-setup --hermes-home \"$HERMES_HOME_DIR\"" in install
    assert "--enable" in install and "UMask=0007" in install
    deploy = (REPO / "deploy/hermes-deploy.sh").read_text()
    assert "TOOLS CLI HELPER STALE" in deploy and "TOOLS SHIM STALE" in deploy


def test_resecuring_a_folder_keeps_the_sharing_set_up_on_purpose(tmp_path, monkeypatch):
    import os
    import pwd

    from hermes_constants import owner_only_mode

    plain = tmp_path / "plain"
    plain.mkdir()
    os.chmod(plain, 0o755)
    assert owner_only_mode(plain) == 0o700
    os.chmod(plain, 0o751)
    assert owner_only_mode(plain) == 0o701
    shared = tmp_path / "shared"
    shared.mkdir()
    os.chmod(shared, 0o2770)
    fake = type("pw", (), {"pw_gid": -1})
    monkeypatch.setattr(pwd, "getpwuid", lambda uid: fake)
    assert owner_only_mode(shared) == 0o2770


# ---------------------------------------------------------------- real path

IMAGE = "pgvector/pgvector@sha256:1d533553fefe4f12e5d80c7b80622ba0c382abb5758856f52983d8789179f0fb"
APP_PASSWORD = "tools-cli-test-pw"


def _ready() -> str:
    if sys.platform == "win32" or not shutil.which("sudo") or not shutil.which("docker"):
        return "needs sudo and docker"
    if subprocess.run(["sudo", "-n", "true"], capture_output=True).returncode:
        return "needs passwordless sudo"
    if subprocess.run(["docker", "info"], capture_output=True).returncode:
        return "needs a running docker daemon"
    if subprocess.run(["id", "hermes"], capture_output=True).returncode:
        return "needs the hermes user"
    if subprocess.run(["sudo", "-n", "-u", "hermes", "test", "-x", str(REPO / ".venv/bin/python")]).returncode:
        return "hermes cannot read this checkout"
    return ""


GATEWAY = r'''
import json, os, subprocess, time
from tools.environments.local import LocalEnvironment
home = os.environ["HERMES_HOME"]
env = LocalEnvironment(cwd=home + "/workspaces", timeout=180)
cmds = {
    "whoami": "id -un",
    "which": "command -v hermes",
    "tool_new": "hermes tool --mode dev new demo-tool",
    "tool_config_file": "printf '{\"retries\": 3}' > cfg.json && hermes tool --mode dev config demo-tool --file ./cfg.json",
    "tool_list": "hermes tool --mode dev list",
    "promote": "hermes promote config:notifications --approve --actor e2e",
    "cron_list": "hermes cron list",
    "vpn_status": "hermes vpn status",
    "kanban_list": "hermes kanban list",
    "owner_show": "hermes owner show",
    "config_show": "hermes config show",
    "profile": "hermes tool list -p other",
    "root": "hermes tool new x --root /tmp",
    "config_file_secret": "hermes tool config demo-tool --file " + home + "/.env",
    "dotenv": "cat " + home + "/.env",
    "sessions": "ls " + home + "/sessions",
    "statedb": "cat " + home + "/state.db",
    "write_ws": "echo hi > note.txt && cat note.txt",
    "read_skill": "cat " + home + "/skills/demo/SKILL.md",
    "write_skill": "echo x >> " + home + "/skills/demo/SKILL.md",
    "edit_scaffold": "echo '// edited' >> " + home + "/tools/demo-tool/mcp/server.mjs && echo edited",
}
out = {}
for key, cmd in cmds.items():
    r = env.execute(cmd)
    out[key] = {"rc": r["returncode"], "out": r["output"]}
tenant = "e2e" + str(os.getpid()) + "x"
r = env.execute("hermes kanban watch --interval 1 --tenant " + tenant, timeout=4)
time.sleep(2)
left = subprocess.run(["pgrep", "-f", "--tenant " + tenant], capture_output=True, text=True)
out["watch_left"] = left.stdout.split()
if left.stdout.split():
    out["watch_ps"] = subprocess.run(["ps", "-o", "pid,ppid,pgid,user,args", "-p", ",".join(left.stdout.split())],
                                     capture_output=True, text=True).stdout
env.cleanup()
try:
    out["gateway_reads_note"] = open(home + "/workspaces/note.txt").read().strip()
except OSError as exc:
    out["gateway_reads_note"] = repr(exc)
print("RESULT" + json.dumps(out))
'''


async def _probe(dsn: str) -> None:
    import asyncpg

    conn = await asyncpg.connect(dsn, ssl=False)
    await conn.close()


async def _owner_sql(dsn: str, sql: str) -> None:
    import asyncpg

    conn = await asyncpg.connect(dsn, ssl=False)
    try:
        await conn.execute(sql)
    finally:
        await conn.close()


def _sudo(script: str) -> None:
    subprocess.run(["sudo", "-n", "bash", "-c", script], check=True)


@pytest.fixture
def pg_dsn():
    container = f"hermes-toolscli-{uuid.uuid4().hex[:12]}"
    subprocess.run(["docker", "pull", IMAGE], check=True, capture_output=True)
    subprocess.run(
        ["docker", "run", "--detach", "--rm", "--name", container,
         "--env", "POSTGRES_PASSWORD=hermes-test", "--env", "POSTGRES_DB=hermes_test",
         "--publish", "127.0.0.1::5432", IMAGE],
        check=True, capture_output=True,
    )
    try:
        port = subprocess.run(["docker", "port", container, "5432/tcp"], check=True,
                              capture_output=True, text=True).stdout.strip().rsplit(":", 1)[1]
        dsn = f"postgresql://postgres:hermes-test@127.0.0.1:{port}/hermes_test"
        for _ in range(80):
            try:
                asyncio.run(_probe(dsn))
                break
            except Exception:
                time.sleep(0.25)
        yield dsn
    finally:
        subprocess.run(["docker", "rm", "--force", container], capture_output=True)


@pytest.mark.skipif(bool(_ready()), reason=_ready() or "ready")
def test_skills_hermes_commands_work_as_hermes_tools_and_nothing_else_does(pg_dsn):
    from hermes_cli import db_migrate, db_setup
    from hermes_cli.access import PrincipalStore
    from hermes_cli.datastore import get_store

    app_dsn = pg_dsn.replace("postgres:hermes-test@", f"hermes_app:{APP_PASSWORD}@")
    db_setup._setup_allowed.clear()
    db_migrate.migrate(pg_dsn, config={"datastore": {"supabase_app": {"dsn": "${DATABASE_URL}"}}},
                       app_password=APP_PASSWORD)
    db_setup._setup_allowed.clear()
    store = get_store("supabase-app", "prod", config={"datastore": {"supabase_app": {"dsn": app_dsn}}})
    asyncio.run(PrincipalStore(store).enroll("leo", display="Leo", role="owner"))
    asyncio.run(_owner_sql(pg_dsn, "INSERT INTO app_dev.artifact_definitions (kind, ref, definition) "
                                   "VALUES ('config', 'notifications', '{\"enabled\": true}'::jsonb)"))

    work = Path(tempfile.mkdtemp(prefix="hermes-tools-e2e-", dir="/tmp"))
    home, backup = work / "home", work / "backup"
    wrapper = "/usr/local/lib/hermes-tools-e2e/hermes"
    (home / "sessions").mkdir(parents=True)
    (home / "skills/demo").mkdir(parents=True)
    (home / "workspaces").mkdir()
    (home / ".env").write_text("TELEGRAM_BOT_TOKEN=gateway-secret\n")
    (home / "state.db").write_text("everyone's chats\n")
    (home / "sessions/s1.json").write_text("{}\n")
    (home / "skills/demo/SKILL.md").write_text("# demo\n")
    (home / "config.yaml").write_text(
        "datastore:\n  mode: prod\n  supabase_app:\n    dsn: ${DATABASE_URL}\n"
        "security:\n  terminal_database_credentials: false\n"
    )
    (work / "gateway.env").write_text(f"DATABASE_URL={app_dsn}\n")
    try:
        _sudo(
            f"chown -R hermes:hermes {work}; chmod 755 {work}; chmod 750 {home}; "
            f"chmod 600 {home}/.env {work}/gateway.env {home}/config.yaml; "
            f"install -d -m 755 {Path(wrapper).parent}; "
            f"printf '#!/bin/sh\\nexec {REPO}/.venv/bin/hermes \"$@\"\\n' > {wrapper}; chmod 755 {wrapper}; "
            f"bash {REPO}/deploy/hermes-tools-setup --hermes-home {home} --hermes-bin {wrapper} "
            f"--env-file {work}/gateway.env --enable --backup-dir {backup} >/dev/null"
        )
        proc = subprocess.run(
            ["sudo", "-n", "-u", "hermes", "env", f"HERMES_HOME={home}", "PATH=/usr/bin:/bin",
             str(REPO / ".venv/bin/python"), "-c", GATEWAY],
            cwd=REPO, capture_output=True, text=True, timeout=600,
        )
        line = next((x for x in proc.stdout.splitlines() if x.startswith("RESULT")), None)
        assert line, proc.stdout[-3000:] + proc.stderr[-3000:]
        out = json.loads(line[len("RESULT"):])
        _sudo(f"bash {backup}/rollback.sh >/dev/null")
        after = subprocess.run(["sudo", "-n", "stat", "-c", "%a %G", str(home), str(home / "workspaces")],
                               capture_output=True, text=True, check=True).stdout.split("\n")
    finally:
        _sudo(f"rm -rf {work} {Path(wrapper).parent}")

    ok = lambda k: out[k]["rc"] == 0  # noqa: E731
    assert out["whoami"]["out"].strip() == "hermes-tools"
    assert out["which"]["out"].strip() == "/usr/local/lib/hermes-tools/bin/hermes"
    for key in ("tool_new", "tool_config_file", "tool_list", "promote", "cron_list",
                "vpn_status", "kanban_list", "owner_show", "write_ws", "read_skill", "edit_scaffold"):
        assert ok(key), (key, out[key])
    assert "demo-tool" in out["tool_list"]["out"]
    assert "notifications" in out["promote"]["out"]
    assert "leo" in out["owner_show"]["out"].lower()
    for key in ("config_show", "profile", "root"):
        assert not ok(key) and "refused" in out[key]["out"], (key, out[key])
    for key in ("config_file_secret", "dotenv", "sessions", "statedb", "write_skill"):
        assert not ok(key) and "gateway-secret" not in out[key]["out"], (key, out[key])
        assert "everyone's chats" not in out[key]["out"]
    assert out["watch_left"] == [], out.get("watch_ps")
    assert out["gateway_reads_note"] == "hi"
    assert after[:2] == ["750 hermes", "755 hermes"]
