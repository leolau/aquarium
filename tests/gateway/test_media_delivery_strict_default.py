"""Security review F21: strict media delivery is the default.

Runs the real ``gateway.platforms.base`` in a fresh Python process with a
temporary HOME / HERMES_HOME (the module reads both at import time) and asks
it which files may attach to a chat reply.
"""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]

_PROBE = """
import json, sys
from gateway.platforms.base import BasePlatformAdapter
paths = json.loads(sys.stdin.read())
print(json.dumps({p: BasePlatformAdapter.validate_media_delivery_path(p) for p in paths}))
"""


def _write(path: Path, data: bytes = b"x", *, age: float = 0.0) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    if age:
        old = time.time() - age
        os.utime(path, (old, old))
    return path


def _validate(home: Path, hermes_home: Path, paths, **env_extra):
    env = {
        k: v
        for k, v in os.environ.items()
        if not k.startswith(("HERMES_MEDIA", "HERMES_HOME", "TERMINAL_CWD"))
    }
    env.update(HOME=str(home), HERMES_HOME=str(hermes_home), TERMINAL_CWD=str(home))
    env.update(env_extra)
    out = subprocess.run(
        [sys.executable, "-c", _PROBE],
        input=json.dumps([str(p) for p in paths]),
        capture_output=True,
        text=True,
        cwd=REPO,
        env=env,
        timeout=120,
        check=True,
    )
    return {Path(k): v for k, v in json.loads(out.stdout.strip().splitlines()[-1]).items()}


@pytest.fixture
def layout(tmp_path):
    """A default install: ~/.hermes inside the home, the agent works in ~."""
    home = tmp_path / "home"
    hh = home / ".hermes"
    two_hours = 7200
    f = {
        # should attach
        "generated_image": _write(hh / "cache" / "images" / "gen.png", age=two_hours),
        "legacy_cache_audio": _write(hh / "audio_cache" / "tts.ogg", age=two_hours),
        "workspace_report": _write(home / "work" / "Q3 report.pdf", age=two_hours),
        "workspace_makefile": _write(home / "work" / "Makefile", age=two_hours),
        "export_thumbnail": _write(hh / "exports" / "thumbnails" / "t1.jpg", age=two_hours),
        "export_file": _write(hh / "exports" / "summary.pdf", age=two_hours),
        "member_workspace_file": _write(hh / "workspaces" / "alice" / "notes.docx", age=two_hours),
        "fresh_tmp_pdf": _write(tmp_path / "scratch" / "new.pdf"),
        # must never attach
        "whatsapp_login": _write(hh / "whatsapp" / "session-connectar" / "creds.json"),
        "git_credentials": _write(home / ".git-credentials"),
        "netrc": _write(home / ".netrc"),
        "npmrc": _write(home / ".npmrc"),
        "pypirc": _write(home / ".pypirc"),
        "vault_token": _write(home / ".vault-token"),
        "password_store": _write(home / ".password-store" / "bank.gpg"),
        "project_env": _write(tmp_path / "srv" / "app" / ".env"),
        "project_env_prod": _write(home / "work" / ".env.production"),
        "env_in_exports": _write(hh / "exports" / ".env"),
        "state_db": _write(hh / "state.db"),
        "kanban_db": _write(hh / "kanban" / "kanban.db"),
        "hermes_log": _write(hh / "logs" / "agent.log", age=two_hours),
        "stale_outside_pdf": _write(tmp_path / "elsewhere" / "old.pdf", age=two_hours),
        "dotfile_in_workspace": _write(home / "work" / ".bash_history", age=two_hours),
        "hidden_dir_in_member_workspace": _write(hh / "workspaces" / "alice" / ".git" / "config.txt", age=two_hours),
        "extensionless_outside": _write(tmp_path / "elsewhere" / "creds"),
    }
    link_dir = home / "work"
    (link_dir / "innocent.pdf").symlink_to(f["whatsapp_login"])
    f["symlink_to_whatsapp_login"] = link_dir / "innocent.pdf"
    (hh / "cache" / "images" / "pic.png").symlink_to(f["git_credentials"])
    f["cache_symlink_to_git_credentials"] = hh / "cache" / "images" / "pic.png"
    return home, hh, f


ALLOWED = {
    "generated_image", "legacy_cache_audio", "export_thumbnail", "export_file",
    "workspace_report", "workspace_makefile",
    "member_workspace_file", "fresh_tmp_pdf",
}
NEVER = {
    "whatsapp_login", "git_credentials", "netrc", "npmrc", "pypirc", "vault_token",
    "password_store", "project_env", "project_env_prod", "env_in_exports", "state_db", "kanban_db",
    "symlink_to_whatsapp_login", "cache_symlink_to_git_credentials",
}


def test_default_is_strict(layout):
    home, hh, f = layout
    result = _validate(home, hh, f.values())
    got = {name for name, p in f.items() if result[p] is not None}
    expected = ALLOWED
    assert got == expected, {
        "attached but should not": sorted(got - expected),
        "blocked but should attach": sorted(expected - got),
    }


def test_opt_out_still_blocks_credentials(layout):
    home, hh, f = layout
    result = _validate(home, hh, f.values(), HERMES_MEDIA_DELIVERY_STRICT="0")
    got = {name for name, p in f.items() if result[p] is not None}
    assert ALLOWED <= got
    assert "stale_outside_pdf" in got  # the point of the opt-out
    assert not got & NEVER, sorted(got & NEVER)
    assert "dotfile_in_workspace" not in got
    assert "extensionless_outside" not in got


def test_config_default_is_strict():
    from hermes_cli.config import DEFAULT_CONFIG

    assert DEFAULT_CONFIG["gateway"]["strict"] is True
