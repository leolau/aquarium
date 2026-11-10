"""`aquarium upgrade` — the root side of Settings → Software upgrade, against a fake box.

Reuses the fake server of test_aquarium_cli (fake root, fake systemctl/docker/cosign, a
local GitHub Releases API). `systemd-run` is a fake that only logs its arguments; the
tests then run `aquarium upgrade run` themselves, as the transient unit would.
"""

from __future__ import annotations

import io
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from test_aquarium_cli import FAKE_LOGGER, Box, Handler, aq, released_box, server  # noqa: F401

pytestmark = pytest.mark.live_system_guard_bypass


@pytest.fixture
def box(tmp_path, monkeypatch, server):  # noqa: F811
    b = Box(tmp_path, monkeypatch, server)
    Handler.routes["/health"] = Handler.routes["/bridge/health"]
    fake = b.bin / "systemd-run"
    fake.write_text(FAKE_LOGGER.replace("#!PY", "#!" + sys.executable))
    fake.chmod(0o755)
    # the job writes its log through fds 1/2; keep pytest's own fds out of it
    monkeypatch.setattr(aq.os, "dup2", lambda *_: None)
    return b


def releases(b):
    Handler.routes["/api/releases?per_page=50"] = (200, b.releases)
    for rel in b.releases:
        rel.setdefault("body", f"## Highlights\n- **Better {rel['tag_name']}** - faster\n")
        rel.setdefault("published_at", "2026-11-01T00:00:00Z")
    return b


def call(b, monkeypatch, capsys, verb, body=None) -> tuple[int, dict]:
    capsys.readouterr()
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(body) if body is not None else ""))
    code = b.run("upgrade", verb)
    lines = [ln for ln in capsys.readouterr().out.splitlines() if ln.startswith("{")]
    return code, (json.loads(lines[-1]) if lines else {})


def test_deploy_output_maps_to_steps():
    lines = ["== local modifications check ==", "== fetching v1.2.0 ==", "== reinstalling package ==",
             "== rebuilding agent-home bundle (agent-home/ changed) ==", "== migrating database ==",
             "== restarting services ==", "deploy OK (abc1234)"]
    assert [aq.deploy_step_for_line(ln) for ln in lines] == [
        None, "download", "install", "build", "database", "restart", None]


def test_check_lists_published_releases_newest_first(box, monkeypatch, capsys):
    releases(released_box(box))
    code, answer = call(box, monkeypatch, capsys, "check")
    assert code == 0 and answer["ok"] and answer["checked_at"]
    tags = [r["tag"] for r in answer["releases"]]
    assert tags == ["v1.2.0-beta.1", "v1.1.0", "v1.0.0"]  # the draft never shows
    first = answer["releases"][1]
    assert first["packaged"] is True and "Better v1.1.0" in first["notes"]
    assert set(first) == {"tag", "name", "published_at", "prerelease", "url", "notes", "packaged"}
    # cached: `releases` answers without asking GitHub again
    Handler.routes["/api/releases?per_page=50"] = (500, {})
    code, again = call(box, monkeypatch, capsys, "releases")
    assert [r["tag"] for r in again["releases"]] == tags and not again["error"]


@pytest.mark.parametrize("body, error", [
    ({"version": "latest; rm -rf /"}, "like v1.2.3"),
    ({"version": "v7.7.7"}, "not a published release"),
    ({"version": "v1.0.0"}, "already installed"),
    ([], "could not be read"),
])
def test_start_refuses_what_it_cannot_install(box, monkeypatch, capsys, body, error):
    releases(released_box(box))
    code, answer = call(box, monkeypatch, capsys, "start", body)
    assert code == 1 and error in answer["error"]
    assert "systemd-run" not in box.log()


def test_start_hands_the_job_to_a_transient_unit(box, monkeypatch, capsys):
    releases(released_box(box))
    code, answer = call(box, monkeypatch, capsys, "start", {"version": "v1.1.0", "by": "Leo <b>"})
    assert code == 0 and answer["started"], answer
    run_line = [ln for ln in box.log().splitlines() if ln.startswith("systemd-run")][-1]
    assert run_line.endswith("--property=Type=exec /usr/local/sbin/aquarium upgrade run")
    job = answer["status"]["job"]
    assert job["phase"] == "starting" and job["from"] == "v1.0.0" and job["to"] == "v1.1.0"
    assert job["by"] == "Leo b" and "pid" not in job and "backup" not in job
    assert [s["key"] for s in job["steps"]] == list(aq.UPGRADE_FLOW["release"])
    # a second start while the first is pending is refused
    code, again = call(box, monkeypatch, capsys, "start", {"version": "v1.1.0"})
    assert code == 1 and "already running" in again["error"]


def test_run_upgrades_records_history_and_offers_rollback(box, monkeypatch, capsys):
    releases(released_box(box))
    call(box, monkeypatch, capsys, "start", {"version": "v1.1.0", "by": "Leo"})
    assert box.run("upgrade", "run") == 0
    assert os.readlink(box.p("/opt/aquarium/current")) == "releases/v1.1.0"
    code, st = call(box, monkeypatch, capsys, "status")
    job = st["job"]
    assert job["result"] == "ok" and job["phase"] == "finished" and not job["alive"]
    assert all(s["state"] == "done" for s in job["steps"]), job["steps"]
    assert any("v1.1.0" in ln for ln in job["log"]) or job["log"] == []
    assert st["installed"]["version"] == "v1.1.0" and st["installed"]["by"] == "Leo"
    assert st["history"][0]["to"] == "v1.1.0" and st["history"][0]["has_backup"]
    assert "backup" not in st["history"][0]
    assert st["rollback"] == {"to": "v1.0.0"}
    assert "/var/backups" not in json.dumps(st)
    assert not box.p("/var/lib/aquarium/upgrade-request.json").exists()


def test_run_without_a_request_does_nothing(box, capsys):
    released_box(box)
    assert box.run("upgrade", "run") == 1
    assert "no upgrade was requested" in capsys.readouterr().out


def test_status_reports_a_job_that_died(box, monkeypatch, capsys):
    released_box(box)
    aq.save_upgrade_status({"id": "20261101T000000Z", "kind": "upgrade", "phase": "running",
                            "pid": 2 ** 22 + 12345, "started": aq.now_iso(), "steps": []})
    _, st = call(box, monkeypatch, capsys, "status")
    assert st["job"]["result"] == "interrupted" and st["job"]["phase"] == "finished"
    assert st["rollback"] is None


# --------------------------------------------------------------------------- git checkout installs


FAKE_DEPLOY = """#!/bin/sh
# fake deploy-hermes.sh: understands --ref, logs it, fails where FAKE_DEPLOY_FAIL says
echo "deploy $*" >> "$FAKE_CALLS"
[ "$1" = "--ref" ] || exit 2
echo "== fetching $2 =="
[ "$FAKE_DEPLOY_FAIL" = "fetch:$2" ] && exit 1
echo "== reinstalling package =="
echo "== rebuilding agent-home bundle (agent-home/ changed) =="
echo "== migrating database =="
[ "$FAKE_DEPLOY_FAIL" = "migrate:$2" ] && exit 1
echo "== restarting services =="
echo "deploy OK"
"""


def git_box(b, monkeypatch):
    repo = b.p("/opt/data/hermes-agent")
    repo.mkdir(parents=True)
    env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@x", "GIT_COMMITTER_NAME": "t",
           "GIT_COMMITTER_EMAIL": "t@x"}
    for argv in (["init", "-q", "-b", "develop"], ["commit", "-q", "--allow-empty", "-m", "one"],
                 ["tag", "v1.0.0"]):
        subprocess.run(["git", "-C", str(repo), *argv], check=True, env=env)
    (repo / "pyproject.toml").write_text("x")
    b.write("/opt/data/deploy-hermes.sh", FAKE_DEPLOY, mode=0o755)
    b.make_release("v1.0.0")
    b.make_release("v1.1.0")
    return releases(b)


def test_git_install_deploys_the_chosen_tag(box, monkeypatch, capsys):
    git_box(box, monkeypatch)
    _, st = call(box, monkeypatch, capsys, "status")
    assert st["installed"]["layout"] == "git" and st["installed"]["version"] == "v1.0.0"
    code, answer = call(box, monkeypatch, capsys, "start", {"version": "v1.1.0"})
    assert code == 0, answer
    assert [s["key"] for s in answer["status"]["job"]["steps"]] == list(aq.UPGRADE_FLOW["git"])
    assert box.run("upgrade", "run") == 0
    assert "deploy --ref v1.1.0" in box.log()
    job = aq.load_upgrade_status()
    assert job["result"] == "ok" and [s["state"] for s in job["steps"]] == ["done"] * 7


def test_failed_git_upgrade_puts_the_old_version_back(box, monkeypatch, capsys):
    git_box(box, monkeypatch)
    monkeypatch.setenv("FAKE_DEPLOY_FAIL", "fetch:v1.1.0")
    call(box, monkeypatch, capsys, "start", {"version": "v1.1.0"})
    restored = []
    monkeypatch.setattr(aq, "_restore_backup", lambda cfg, path: restored.append(path))
    assert box.run("upgrade", "run") == 1
    job = aq.load_upgrade_status()
    assert job["result"] == "rolled back"
    assert "deploy --ref v1.1.0" in box.log() and f"deploy --ref {job['from_ref']}" in box.log()
    assert restored == []  # the database was never touched, so the backup is not needed
    assert {s["key"]: s["state"] for s in job["steps"]}["download"] == "failed"


def test_failed_migration_restores_the_backup(box, monkeypatch, capsys):
    git_box(box, monkeypatch)
    monkeypatch.setenv("FAKE_DEPLOY_FAIL", "migrate:v1.1.0")
    call(box, monkeypatch, capsys, "start", {"version": "v1.1.0"})
    restored = []
    monkeypatch.setattr(aq, "_restore_backup", lambda cfg, path: restored.append(path))
    assert box.run("upgrade", "run") == 1
    job = aq.load_upgrade_status()
    assert job["result"] == "rolled back" and restored == [job["backup"]]
    assert aq.load_state()["upgrades"][-1]["result"] == "rolled back"


def test_old_deploy_script_is_refused_before_anything_runs(box, monkeypatch, capsys):
    git_box(box, monkeypatch)
    box.write("/opt/data/deploy-hermes.sh", "#!/bin/sh\nexit 0\n", mode=0o755)
    code, answer = call(box, monkeypatch, capsys, "start", {"version": "v1.1.0"})
    assert code == 1 and "too old" in answer["error"]


def test_sudoers_rule_allows_only_the_upgrade_verbs():
    rule = (Path(aq.__file__).parent / "sudoers.d" / "aquarium-upgrade").read_text()
    cmds = [ln.split("NOPASSWD:", 1)[1].strip() for ln in rule.splitlines() if "NOPASSWD:" in ln]
    assert cmds == [f"/usr/local/sbin/aquarium upgrade {v}"
                    for v in ("status", "releases", "check", "start", "rollback")]
    assert not any(" run" in c or "*" in c for c in cmds)


def test_git_checkout_check_lists_branch_commits_not_installed(box, monkeypatch, capsys):
    git_box(box, monkeypatch)
    repo = box.p("/opt/data/hermes-agent")
    head = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], capture_output=True, text=True,
                          check=True).stdout.strip()
    Handler.routes[f"/api/compare/{head}...develop"] = (200, {"ahead_by": 2, "behind_by": 0, "commits": [
        {"sha": "a" * 40, "commit": {"message": "feat: one (#1)\n\nbody", "committer": {"date": "2026-11-09T00:00:00Z"}}},
        {"sha": "b" * 40, "commit": {"message": "fix: two (#2)", "committer": {"date": "2026-11-10T00:00:00Z"}}},
    ]})
    code, answer = call(box, monkeypatch, capsys, "check")
    assert code == 0 and answer["ok"]
    co = answer["checkout"]
    assert co["branch"] == "develop" and co["commit"] == head and co["behind"] == 2 and not co["error"]
    assert co["tip"] == "b" * 9
    assert [(c["sha"], c["title"]) for c in co["commits"]] == [("b" * 9, "fix: two (#2)"), ("a" * 9, "feat: one (#1)")]

    # a deploy since the last check: `releases` asks GitHub again instead of showing a stale count
    env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@x", "GIT_COMMITTER_NAME": "t",
           "GIT_COMMITTER_EMAIL": "t@x"}
    subprocess.run(["git", "-C", str(repo), "commit", "-q", "--allow-empty", "-m", "two"], check=True, env=env)
    head2 = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], capture_output=True, text=True,
                           check=True).stdout.strip()
    Handler.routes[f"/api/compare/{head2}...develop"] = (200, {"ahead_by": 0, "commits": []})
    _, again = call(box, monkeypatch, capsys, "releases")
    assert again["checkout"]["commit"] == head2 and again["checkout"]["behind"] == 0


def test_git_checkout_compare_failure_keeps_the_release_list(box, monkeypatch, capsys):
    git_box(box, monkeypatch)
    code, answer = call(box, monkeypatch, capsys, "check")  # no compare route: GitHub answers 404
    assert code == 0 and answer["ok"] and [r["tag"] for r in answer["releases"]]
    assert answer["checkout"]["behind"] is None and answer["checkout"]["error"]
