"""install-aquarium.sh: syntax, settings, and the helpers that make re-runs safe.

The script needs root and a fresh VM end to end, so these tests run its pure
helpers (``secret``, ``set_env``, ``jwt``, ``fix_paths``, ``check``) and the
config.yaml merge step in isolation against temp files.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT = REPO_ROOT / "install-aquarium.sh"
TEXT = SCRIPT.read_text()


def _function(name: str) -> str:
    """Source of a one-line or multi-line shell function ``name() { ... }``."""
    one_line = re.search(rf"^{name}\(\) \{{.*\}}$", TEXT, re.MULTILINE)
    if one_line:
        return one_line.group(0)
    block = re.search(rf"^{name}\(\) \{{.*?^\}}$", TEXT, re.MULTILINE | re.DOTALL)
    assert block, f"{name}() not found in install-aquarium.sh"
    return block.group(0)


def _bash(snippet: str, env: dict | None = None, cwd: Path | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", "-c", "set -Eeuo pipefail\n" + snippet],
        capture_output=True, text=True, env={**os.environ, **(env or {})}, cwd=cwd, timeout=60,
    )


def test_script_parses():
    proc = subprocess.run(["bash", "-n", str(SCRIPT)], capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr


@pytest.mark.skipif(shutil.which("shellcheck") is None, reason="shellcheck not installed")
def test_shellcheck_has_no_errors():
    proc = subprocess.run(
        ["shellcheck", "--severity=error", str(SCRIPT)], capture_output=True, text=True
    )
    assert proc.returncode == 0, proc.stdout


def test_strict_mode_and_root_guard_come_first():
    head = TEXT[: TEXT.index('log "Service account and secrets"')]
    assert "set -Eeuo pipefail" in head
    assert re.search(r"id -u.*-eq 0|EUID", head), "the script must refuse to run without root"


def _settings(env: dict) -> dict:
    block = TEXT[TEXT.index("ROOT=${AQUARIUM_ROOT"): TEXT.index("APP_ENV=")]
    block += TEXT[TEXT.index("APP_ENV="):].split("\n", 1)[0] + "\n"
    out = _bash(block + "\nfor v in ROOT REPO_URL BRANCH OWNER_ID APP HERMES_HOME_DIR SECRETS APP_ENV; do echo \"$v=${!v}\"; done", env)
    assert out.returncode == 0, out.stderr
    return dict(line.split("=", 1) for line in out.stdout.splitlines())


def test_settings_default_and_override():
    clean = {k: "" for k in os.environ if k.startswith("AQUARIUM_")}
    defaults = _settings({**clean})
    assert defaults["ROOT"] == "/opt/data"
    assert defaults["BRANCH"] == "develop"
    assert defaults["OWNER_ID"] == "admin"
    for key in ("APP", "HERMES_HOME_DIR", "SECRETS", "APP_ENV"):
        assert defaults[key].startswith("/opt/data/"), key

    custom = _settings({
        "AQUARIUM_ROOT": "/srv/aq", "AQUARIUM_BRANCH": "main",
        "AQUARIUM_REPO": "https://example.com/fork.git", "AQUARIUM_OWNER_ID": "leo",
    })
    assert custom["REPO_URL"] == "https://example.com/fork.git"
    assert custom["BRANCH"] == "main" and custom["OWNER_ID"] == "leo"
    for key in ("APP", "HERMES_HOME_DIR", "SECRETS", "APP_ENV"):
        assert custom[key].startswith("/srv/aq/"), key


def test_header_install_url_matches_default_repo():
    default_repo = re.search(r"REPO_URL=\$\{AQUARIUM_REPO:-https://github.com/([^}]+?)\.git\}", TEXT).group(1)
    raw = re.search(r"raw\.githubusercontent\.com/([^/]+/[^/]+)/([^/]+)/install-aquarium\.sh", TEXT)
    assert raw.group(1) == default_repo
    default_branch = re.search(r"BRANCH=\$\{AQUARIUM_BRANCH:-([^}]+)\}", TEXT).group(1)
    assert raw.group(2) == default_branch


def test_every_documented_setting_is_read():
    documented = set(re.findall(r"^#\s+(AQUARIUM_[A-Z_]+)", TEXT, re.MULTILINE))
    documented |= set(re.findall(r"/ (AQUARIUM_[A-Z_]+)", TEXT))
    code = "\n".join(l for l in TEXT.splitlines() if not l.lstrip().startswith("#"))
    for name in documented:
        assert name in code, f"{name} is documented but never used"


def _secret_lib(secrets: Path) -> str:
    return f'SECRETS={secrets}\n{_function("rand")}\n{_function("secret")}\n'


def test_secret_is_generated_once_then_reused(tmp_path):
    secrets = tmp_path / "aquarium-secrets.env"
    secrets.touch()
    lib = _secret_lib(secrets)
    first = _bash(lib + "secret POSTGRES_PASSWORD")
    second = _bash(lib + "secret POSTGRES_PASSWORD other-value")
    assert first.returncode == 0, first.stderr
    assert re.fullmatch(r"[0-9a-f]{48}", first.stdout)
    assert second.stdout == first.stdout
    assert secrets.read_text().count("POSTGRES_PASSWORD=") == 1


def test_secret_keeps_given_value_and_separates_names(tmp_path):
    secrets = tmp_path / "s.env"
    secrets.write_text("OWNER_PASSWORD=already-set\n")
    lib = _secret_lib(secrets)
    assert _bash(lib + "secret OWNER_PASSWORD new").stdout == "already-set"
    assert _bash(lib + "secret TENANT aquarium").stdout == "aquarium"
    assert _bash(lib + "secret TENANT_ID").stdout != "aquarium"
    assert "TENANT=aquarium" in secrets.read_text()


def test_set_env_replaces_or_appends(tmp_path):
    env = tmp_path / ".env"
    env.write_text("A=1\nPOSTGRES_PASSWORD=old\n# POSTGRES_PASSWORD=comment\nB=2\n")
    lib = _function("set_env") + "\n"
    proc = _bash(lib + f'set_env {env} POSTGRES_PASSWORD "n3w/v@l&ue"\nset_env {env} NEW_KEY x=y\nset_env {env} NEW_KEY z')
    assert proc.returncode == 0, proc.stderr
    lines = env.read_text().splitlines()
    assert lines == ["A=1", "POSTGRES_PASSWORD=n3w/v@l&ue", "# POSTGRES_PASSWORD=comment", "B=2", "NEW_KEY=z"]


def _b64(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


@pytest.mark.parametrize("role", ["anon", "service_role"])
def test_jwt_is_a_valid_hs256_supabase_key(role):
    secret = "s" * 64
    proc = _bash(f'JWT_SECRET={secret}\n{_function("jwt")}\njwt {role}')
    assert proc.returncode == 0, proc.stderr
    header, payload, sig = proc.stdout.strip().split(".")
    expected = hmac.new(secret.encode(), f"{header}.{payload}".encode(), hashlib.sha256).digest()
    assert hmac.compare_digest(_b64(sig), expected)
    assert json.loads(_b64(header)) == {"alg": "HS256", "typ": "JWT"}
    claims = json.loads(_b64(payload))
    assert claims["role"] == role and claims["iss"] == "supabase"
    assert claims["iat"] <= time.time() + 5
    assert claims["exp"] - claims["iat"] >= 9 * 365 * 86400


def test_fix_paths_rewrites_only_the_install_root():
    proc = _bash(
        f'APP=/srv/aq/hermes-agent\nEMBED=/srv/aq/hermes-embed\n{_function("fix_paths")}\n'
        "printf 'ExecStart=/opt/data/hermes-agent/.venv/bin/hermes\\nWorkingDirectory=/opt/data/hermes-embed\\nEnvironmentFile=/opt/data/hermes.env\\n' | fix_paths"
    )
    assert proc.stdout.splitlines() == [
        "ExecStart=/srv/aq/hermes-agent/.venv/bin/hermes",
        "WorkingDirectory=/srv/aq/hermes-embed",
        "EnvironmentFile=/opt/data/hermes.env",
    ]


@pytest.mark.parametrize("unit", [
    "agent-home/deploy/agent-home.service",
    "app-mcp/deploy/app-mcp.service",
    "deploy/hermes-embed.service",
])
def test_installed_units_exist_and_use_rewritable_paths(unit):
    assert f"fix_paths < {unit}" in TEXT
    body = (REPO_ROOT / unit).read_text()
    exec_start = re.search(r"^ExecStart=(\S+)", body, re.MULTILINE).group(1)
    assert exec_start.startswith(("/opt/data/hermes-agent/", "/opt/data/hermes-embed/", "/usr/")), exec_start


def test_check_reports_and_fails():
    proc = _bash(f'fail=0\n{_function("check")}\ncheck good true\ncheck bad false\necho "fail=$fail"')
    assert proc.stdout.splitlines() == ["  ok    good", "  FAIL  bad", "fail=1"]


def test_health_checks_decide_the_exit_code():
    assert TEXT.rstrip().endswith("exit $fail")
    for unit in ("hermes-embed", "hermes-dashboard", "hermes-gateway", "app-mcp", "agent-home"):
        assert unit in TEXT[TEXT.index('log "Health checks"'):]


def _config_merge_program() -> str:
    start = TEXT.index('as_hermes "$APP/.venv/bin/python" - "$OWNER_ID"')
    body = TEXT[start:].split("<<'PY'\n", 1)[1]
    return body.split("\nPY\n", 1)[0]


def _run_config_merge(home: Path, owner="admin", secret="sek"):
    prog = _config_merge_program()
    return subprocess.run(
        [sys.executable, "-", owner, secret], input=prog, capture_output=True, text=True,
        env={**os.environ, "HERMES_HOME": str(home), "PYTHONPATH": str(REPO_ROOT)}, cwd=REPO_ROOT, timeout=60,
    )


def test_config_merge_on_fresh_home(tmp_path):
    proc = _run_config_merge(tmp_path)
    assert proc.returncode == 0, proc.stderr
    cfg = yaml.safe_load((tmp_path / "config.yaml").read_text())
    assert cfg["datastore"]["mode"] == "prod"
    assert cfg["memory"]["embedding"]["endpoint"] == "http://127.0.0.1:8791"
    basic = cfg["dashboard"]["basic_auth"]
    assert basic["username"] == "admin" and basic["secret"] == "sek"
    assert basic["password_hash"].startswith("scrypt$")
    # The placeholder is random per run: nobody knows it until the setup link sets one.
    other = tmp_path / "other"
    other.mkdir()
    assert _run_config_merge(other).returncode == 0
    assert yaml.safe_load((other / "config.yaml").read_text())["dashboard"]["basic_auth"]["password_hash"] != basic["password_hash"]
    assert (tmp_path / "config.yaml").stat().st_mode & 0o777 == 0o600


def test_config_merge_never_overwrites_existing_settings(tmp_path):
    existing = {
        "model": {"default": "my-model"},
        "datastore": {"mode": "dev"},
        "memory": {"provider": "builtin", "embedding": {"provider": "openai"}},
        "dashboard": {"basic_auth": {"username": "leo", "password_hash": "KEEP", "secret": "old"}},
    }
    (tmp_path / "config.yaml").write_text(yaml.safe_dump(existing))
    proc = _run_config_merge(tmp_path)
    assert proc.returncode == 0, proc.stderr
    cfg = yaml.safe_load((tmp_path / "config.yaml").read_text())
    assert cfg["model"] == existing["model"]
    assert cfg["datastore"] == existing["datastore"]
    assert cfg["memory"]["provider"] == "builtin"
    assert cfg["memory"]["embedding"] == {"provider": "openai"}
    assert cfg["memory"]["rag"] == {"enabled": True}
    assert cfg["dashboard"]["basic_auth"] == existing["dashboard"]["basic_auth"]

    again = _run_config_merge(tmp_path)
    assert again.returncode == 0
    assert yaml.safe_load((tmp_path / "config.yaml").read_text()) == cfg


def test_existing_model_keys_file_is_kept():
    assert '[ -f "$HERMES_HOME_DIR/.env" ] || install' in TEXT


def test_no_owner_password_in_a_file_and_a_setup_link_at_the_end():
    code = "\n".join(line for line in TEXT.splitlines() if not line.lstrip().startswith("#"))
    assert "OWNER_PASSWORD" not in code
    assert 'hermes_db setup-link --origin "$ORIGIN"' in code
    assert code.index("hermes_db owner init") < code.index("hermes_db setup-link")
