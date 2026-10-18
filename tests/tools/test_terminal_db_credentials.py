"""F16 option C: the agent's shell gets DATABASE_URL / the service-role key
only when ``security.terminal_database_credentials`` is true."""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

from tools import env_passthrough
from tools.environments.local import LocalEnvironment, _sanitize_subprocess_env
from tools.terminal_db_credentials import HIDDEN_MARKER, SETTING

REPO = Path(__file__).resolve().parents[2]
DSN = "postgres://postgres:pw-canary@127.0.0.1:5432/postgres"
KEY = "service-role-canary"


def _write_config(home: Path, value=None) -> None:
    cfg = {"model": {"default": "x"}}
    if value is not None:
        cfg["security"] = {"terminal_database_credentials": value}
    (home / "config.yaml").write_text(yaml.safe_dump(cfg))


@pytest.fixture
def home(tmp_path, monkeypatch):
    h = tmp_path / "hermes-home"
    h.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(h))
    monkeypatch.setenv("DATABASE_URL", DSN)
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", KEY)
    monkeypatch.setenv("HERMES_DASHBOARD_SUPABASE_SERVICE_ROLE_KEY", KEY)
    monkeypatch.setattr(env_passthrough, "_config_passthrough", None)
    env_passthrough.clear_env_passthrough()
    yield h
    env_passthrough.clear_env_passthrough()


def _shell(home: Path, command: str) -> str:
    env = LocalEnvironment(cwd=str(home), timeout=20)
    try:
        return env.execute(command)["output"]
    finally:
        env.cleanup()


def test_terminal_hides_db_credentials_by_default(home):
    _write_config(home)
    out = _shell(home, "env")
    assert DSN not in out and KEY not in out
    assert f"{HIDDEN_MARKER}=1" in out


def test_explicit_false_hides_them(home):
    _write_config(home, False)
    assert DSN not in _shell(home, "printenv DATABASE_URL")


def test_setting_true_lets_them_through(home):
    _write_config(home, True)
    out = _shell(home, "printenv DATABASE_URL SUPABASE_SERVICE_ROLE_KEY")
    assert DSN in out and KEY in out
    assert HIDDEN_MARKER not in _shell(home, "env")


def test_string_true_is_not_enough(home):
    """Only a real YAML boolean opens it; a typo stays closed."""
    _write_config(home, "yes please")
    assert DSN not in _shell(home, "printenv DATABASE_URL")


def test_background_process_env_hides_them(home):
    """process_registry (background/PTY commands) builds env with this."""
    _write_config(home)
    env = _sanitize_subprocess_env(os.environ, {"DATABASE_URL": DSN})
    assert "DATABASE_URL" not in env and "SUPABASE_SERVICE_ROLE_KEY" not in env
    _write_config(home, True)
    assert _sanitize_subprocess_env(os.environ)["DATABASE_URL"] == DSN


def test_skill_or_config_passthrough_cannot_reopen_them(home):
    (home / "config.yaml").write_text(yaml.safe_dump(
        {"terminal": {"env_passthrough": ["DATABASE_URL"]}}
    ))
    env_passthrough.register_env_passthrough(["SUPABASE_SERVICE_ROLE_KEY"])
    assert not env_passthrough.is_env_passthrough("DATABASE_URL")
    assert not env_passthrough.is_env_passthrough("SUPABASE_SERVICE_ROLE_KEY")
    assert "DATABASE_URL" not in env_passthrough.get_all_passthrough()
    assert DSN not in _shell(home, "printenv DATABASE_URL")


def test_execute_code_child_never_gets_them(home):
    from tools.code_execution_tool import _scrub_child_env

    _write_config(home)
    env_passthrough.register_env_passthrough(["DATABASE_URL"])
    child = _scrub_child_env(dict(os.environ))
    assert "DATABASE_URL" not in child and "SUPABASE_SERVICE_ROLE_KEY" not in child


def test_docker_forwards_them_only_when_allowed(home):
    from tools.environments.docker import DockerEnvironment

    _write_config(home)
    env_passthrough.register_env_passthrough(["DATABASE_URL"])
    docker = DockerEnvironment.__new__(DockerEnvironment)
    docker._env = {}
    docker._forward_env = []
    assert not any("DATABASE_URL" in a for a in docker._build_init_env_args())


def test_cli_error_names_the_setting(home, monkeypatch):
    """`hermes promote` from a hidden shell: the DSN reference stays unresolved."""
    from hermes_cli.datastore import SupabaseAppStore

    monkeypatch.setenv(HIDDEN_MARKER, "1")
    with pytest.raises(RuntimeError, match=SETTING.replace(".", r"\.")):
        asyncio.run(SupabaseAppStore("prod", "app_prod", "${DATABASE_URL}").connect())


def test_storage_error_names_the_setting(home, monkeypatch):
    from hermes_cli.filestore import StorageNotConfigured, SupabaseStorage

    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY")
    monkeypatch.setenv("SUPABASE_URL", "http://127.0.0.1:8000")
    monkeypatch.setenv(HIDDEN_MARKER, "1")
    with pytest.raises(StorageNotConfigured, match="terminal_database_credentials"):
        SupabaseStorage.from_env()


def test_cli_error_without_marker_is_unchanged(home, monkeypatch):
    from hermes_cli.datastore import SupabaseAppStore

    monkeypatch.delenv(HIDDEN_MARKER, raising=False)
    with pytest.raises(RuntimeError) as exc:
        asyncio.run(SupabaseAppStore("prod", "app_prod", "").connect())
    assert SETTING not in str(exc.value)


def _run_keep_script(home: Path) -> subprocess.CompletedProcess:
    env = {k: v for k, v in os.environ.items() if k != "HERMES_MANAGED"}
    env["HERMES_HOME"] = str(home)
    return subprocess.run(
        [sys.executable, "-I", str(REPO / "scripts" / "keep_terminal_db_credentials.py")],
        env=env, capture_output=True, text=True, cwd=str(home), timeout=60,
    )


def test_deploy_switch_turns_it_on_for_an_existing_profile(home):
    _write_config(home)
    r = _run_keep_script(home)
    assert r.returncode == 0, r.stderr
    cfg = yaml.safe_load((home / "config.yaml").read_text())
    assert cfg["security"]["terminal_database_credentials"] is True
    assert cfg["model"] == {"default": "x"}
    # Second deploy: already set, nothing changes.
    before = (home / "config.yaml").read_text()
    assert "kept" in _run_keep_script(home).stdout
    assert (home / "config.yaml").read_text() == before


def test_deploy_switch_keeps_an_explicit_false(home):
    _write_config(home, False)
    assert "kept" in _run_keep_script(home).stdout
    cfg = yaml.safe_load((home / "config.yaml").read_text())
    assert cfg["security"]["terminal_database_credentials"] is False


def test_deploy_switch_ignores_a_missing_config(home):
    r = _run_keep_script(home)
    assert r.returncode == 0 and not (home / "config.yaml").exists()


def test_deploy_script_runs_the_switch_as_hermes():
    text = (REPO / "deploy" / "hermes-deploy.sh").read_text()
    assert "runuser -u hermes" in text
    assert "scripts/keep_terminal_db_credentials.py" in text
    assert text.index("keep_terminal_db_credentials") < text.index('echo "== restarting services =="')


def test_installer_writes_explicit_false():
    text = (REPO / "install-aquarium.sh").read_text()
    assert 'setdefault("terminal_database_credentials", False)' in text
