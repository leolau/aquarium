"""Release-gate checks e-g and the TEST-install guard of scripts/live_access_check.py.

Real imports and the real ``terminal`` tool (local backend) on a temp
HERMES_HOME; only the facts that differ per box (mount table, secret file
locations, approval implementation) are pointed at temp data.
"""

from __future__ import annotations

import os
import sys

import pytest

import scripts.live_access_check as lac

ADMIN = lac.TestUser(role="admin", email="", display="zz-admin", user_id="uid-admin")
MEMBER = lac.TestUser(role="member", email="", display="zz-member", user_id="uid-member")
OPEN_POLICY = {"admin": {"deny_tools": []}}


@pytest.fixture
def home(tmp_path, monkeypatch):
    h = tmp_path / "hermes"
    h.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(h))
    return h


def _report():
    lines = []
    return lac.Report(out=lines.append), lines


def _status(report, prefix):
    return [r["status"] for r in report.results if r["check"].startswith(prefix)]


# -- TEST-install guard ------------------------------------------------------


@pytest.fixture
def fake_production_hosts(monkeypatch):
    monkeypatch.setattr(lac, "PRODUCTION_HOSTS", frozenset({"home.example.com", "203.0.113.10"}))


def test_production_hosts_are_set():
    assert lac.PRODUCTION_HOSTS


@pytest.mark.parametrize(
    "url,addrs,hit",
    [
        ("http://127.0.0.1:9119", {"10.0.0.5", "test-box"}, False),
        ("https://home.example.com", set(), True),
        ("http://127.0.0.1:9119", {"203.0.113.10"}, True),
    ],
)
def test_production_markers(url, addrs, hit, fake_production_hosts):
    assert bool(lac.production_markers(url, addrs)) is hit


def test_refuses_production_before_touching_anything(monkeypatch, tmp_path, fake_production_hosts):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setattr(lac, "local_addresses", lambda: {"203.0.113.10"})
    monkeypatch.setattr(lac, "build_members", lambda: pytest.fail("must not provision"))
    lines = []
    code = lac.main(["--base-url", "http://127.0.0.1:9119"], out=lines.append)
    assert code == 2
    assert "REFUSED" in lines[0] and "203.0.113.10" in lines[0]


# -- f. network folders ------------------------------------------------------


def test_read_mounts_decodes_escapes(tmp_path):
    table = tmp_path / "mounts"
    table.write_text(
        "//fs/share /opt/data/vpn-files/net-a\\040b cifs ro,nosuid 0 0\n"
        "/dev/sda1 / ext4 rw,relatime 0 0\n"
    )
    mounts = lac.network_folder_mounts(lac.read_mounts(str(table)), "/opt/data/vpn-files")
    assert mounts == [("/opt/data/vpn-files/net-a b", ["ro", "nosuid"])]


def _mounted(tmp_path, monkeypatch, opts):
    from hermes_cli import vpn

    root = tmp_path / "vpn-files"
    folder = root / "net-office"
    folder.mkdir(parents=True)
    monkeypatch.setattr(vpn, "MOUNT_ROOT", str(root))
    table = tmp_path / "mounts"
    table.write_text(f"//fs/share {folder} cifs {opts} 0 0\n")
    return folder, str(table)


def test_writable_network_folder_fails(home, tmp_path, monkeypatch):
    folder, table = _mounted(tmp_path, monkeypatch, "rw,nosuid")
    report, _ = _report()
    lac.check_network_folders(report, {"admin": ADMIN}, OPEN_POLICY, "zz-t", mounts_path=table)
    assert _status(report, "[f]") == ["FAIL", "FAIL"]
    assert list(folder.iterdir()) == []  # probe removed again


@pytest.mark.skipif(os.geteuid() == 0, reason="root ignores directory modes")
def test_read_only_network_folder_passes(home, tmp_path, monkeypatch):
    folder, table = _mounted(tmp_path, monkeypatch, "ro,nosuid")
    folder.chmod(0o555)
    try:
        report, _ = _report()
        lac.check_network_folders(report, {"admin": ADMIN}, OPEN_POLICY, "zz-t", mounts_path=table)
    finally:
        folder.chmod(0o755)
    assert _status(report, "[f]") == ["PASS", "PASS"]


def test_no_network_folder_is_a_skip(home, tmp_path):
    table = tmp_path / "mounts"
    table.write_text("/dev/sda1 / ext4 rw 0 0\n")
    report, _ = _report()
    lac.check_network_folders(report, {"admin": ADMIN}, OPEN_POLICY, "zz-t", mounts_path=str(table))
    assert _status(report, "[f]") == ["SKIP"]


# -- g. secrets from the agent terminal --------------------------------------


def test_secret_name_patterns():
    names = ["PATH", "HOME", "DATABASE_URL", "AGENT_HOME_SESSION_SECRET", "SMTP_PASSWORD",
             "SUPABASE_SERVICE_ROLE_KEY", "TELEGRAM_BOT_TOKEN", "OPENAI_API_KEY", "LANG"]
    assert lac.secret_env_names(names) == sorted(names[2:-1])


def test_readable_secret_file_fails_and_value_is_never_printed(home, tmp_path, monkeypatch):
    secret = tmp_path / "aquarium" / "gateway.env"
    secret.parent.mkdir()
    secret.write_text("DATABASE_URL=postgres://u:hunter2-zz@db/x\n")
    monkeypatch.setattr(lac, "SECRET_FILE_GLOBS", (str(secret.parent) + "/*",))
    report, lines = _report()
    lac.check_terminal_secrets(report, {"admin": ADMIN, "member": MEMBER}, {
        **OPEN_POLICY, "member": {"deny_tools": ["terminal"]}}, "zz-t")
    files = [r for r in report.results if "secret files" in r["check"]]
    assert [r["status"] for r in files] == ["FAIL"] and str(secret) in files[0]["detail"]
    assert not any("member" in r["check"] for r in report.results)
    assert "hunter2-zz" not in "\n".join(lines)


@pytest.mark.skipif(os.geteuid() == 0, reason="root reads any file")
def test_unreadable_secret_file_passes(home, tmp_path, monkeypatch):
    secret = tmp_path / "aquarium" / "gateway.env"
    secret.parent.mkdir()
    secret.write_text("X=1\n")
    secret.chmod(0)
    monkeypatch.setattr(lac, "SECRET_FILE_GLOBS", (str(secret.parent) + "/*",))
    report, _ = _report()
    lac.check_terminal_secrets(report, {"admin": ADMIN}, OPEN_POLICY, "zz-t")
    assert [r["status"] for r in report.results if "secret files" in r["check"]] == ["PASS"]


def test_database_url_verdict_matches_what_the_terminal_really_inherits(home, monkeypatch):
    """The check must report exactly what the real sanitizer lets through."""
    from tools.environments.local import _sanitize_subprocess_env

    monkeypatch.setenv("DATABASE_URL", "postgres://u:hunter2-zz@db/x")
    monkeypatch.setattr(lac, "SECRET_FILE_GLOBS", ())
    report, lines = _report()
    lac.check_terminal_secrets(report, {"admin": ADMIN}, OPEN_POLICY, "zz-t")
    leaks = "DATABASE_URL" in _sanitize_subprocess_env(dict(os.environ))
    db = [r for r in report.results if "DATABASE_URL" in r["check"]]
    assert [r["status"] for r in db] == ["FAIL" if leaks else "PASS"]
    assert "hunter2-zz" not in "\n".join(lines)


# -- e. approvals ------------------------------------------------------------


@pytest.fixture
def guard():
    sys.path.insert(0, str(lac.REPO_ROOT / "app-mcp"))
    from app_mcp import guard as g

    return g


def _approvals(monkeypatch, guard, gated, resolver):
    from tools import approval

    monkeypatch.setattr(guard, "looks_destructive", lambda name: gated)
    monkeypatch.setattr(approval, "resolve_gateway_approval", resolver)
    report, _ = _report()
    lac.check_approvals(report, {"member": MEMBER, "admin": ADMIN})
    return [r["status"] for r in report.results], report


def test_open_findings_fail(monkeypatch, guard):
    def unbound(session_key, choice, resolve_all=False):
        return 1

    statuses, report = _approvals(monkeypatch, guard, False, unbound)
    assert statuses == ["FAIL", "FAIL"]
    assert "F22" in report.results[1]["detail"]


def test_requester_bound_approvals_pass(monkeypatch, guard):
    from tools import approval

    def bound(session_key, choice, resolve_all=False, approver_id=None):
        queue = approval._gateway_queues.get(session_key) or []
        mine = [e for e in queue if e.data.get("requester_id") == approver_id]
        for e in mine:
            e.result = choice
        return len(mine)

    statuses, _ = _approvals(monkeypatch, guard, True, bound)
    assert statuses == ["PASS", "PASS"]
    assert not any(k.startswith(lac.TAG_PREFIX) for k in approval._gateway_queues)


def test_approver_param_that_is_ignored_still_fails(monkeypatch, guard):
    from tools import approval

    def ignores(session_key, choice, resolve_all=False, approver_id=None):
        queue = approval._gateway_queues.pop(session_key, [])
        for e in queue:
            e.result = choice
        return len(queue)

    statuses, _ = _approvals(monkeypatch, guard, True, ignores)
    assert statuses == ["PASS", "FAIL"]


def test_real_modules_report_without_crashing(guard):
    report, _ = _report()
    lac.check_approvals(report, {"member": MEMBER, "admin": ADMIN})
    assert len(report.results) == 2 and all(r["status"] in {"PASS", "FAIL"} for r in report.results)
