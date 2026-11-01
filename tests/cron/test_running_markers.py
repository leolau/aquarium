"""Cron "running since" markers: what other processes (the activity bar)
read to know a job is executing, since the scheduler's running set lives
only in the gateway's memory."""

import json
import os
import time

import cron.jobs as jobs
import cron.scheduler as s


def test_marker_round_trip(tmp_path, monkeypatch):
    monkeypatch.setattr(jobs, "CRON_DIR", tmp_path)
    marker = jobs.mark_job_running({"id": "abc", "name": "Digest"})
    assert marker is not None and marker.exists()
    [row] = jobs.list_running_jobs(tmp_path)
    assert row["job_id"] == "abc" and row["name"] == "Digest"
    assert abs(row["started_at"] - time.time()) < 5
    jobs.clear_job_running(marker)
    assert jobs.list_running_jobs(tmp_path) == []
    jobs.clear_job_running(marker)  # idempotent


def _write(tmp_path, fname, **payload):
    d = tmp_path / "running"
    d.mkdir(exist_ok=True)
    (d / f"{fname}.json").write_text(json.dumps(payload))


def test_crashed_and_stale_markers_are_ignored(tmp_path):
    import socket

    host = socket.gethostname()
    now = time.time()
    _write(tmp_path, "live", job_id="live", name="L", started_at=now, pid=os.getpid(), host=host)
    # The pid no longer exists → the process that wrote it crashed.
    _write(tmp_path, "dead", job_id="dead", name="D", started_at=now - 5, pid=2**22 + 7, host=host)
    # Older than the age cap, even with a live pid.
    _write(tmp_path, "old", job_id="old", name="O", started_at=now - 10 * 86400, pid=os.getpid(), host=host)
    # Garbage never breaks the read.
    (tmp_path / "running" / "junk.json").write_text("{not json")
    assert [r["job_id"] for r in jobs.list_running_jobs(tmp_path)] == ["live"]


def test_pid_reused_by_a_younger_process_is_not_the_run(tmp_path):
    import socket

    # Our own pid, but the marker predates this process's birth.
    _write(tmp_path, "reused", job_id="reused", name="R", started_at=time.time() - 3600 * 23,
           pid=os.getpid(), host=socket.gethostname())
    assert jobs.list_running_jobs(tmp_path) == []


def test_run_one_job_holds_the_marker_only_while_running(tmp_path, monkeypatch):
    monkeypatch.setattr(jobs, "CRON_DIR", tmp_path)
    seen = {}

    def fake_run_job(job):
        seen["during"] = [r["job_id"] for r in jobs.list_running_jobs(tmp_path)]
        raise RuntimeError("boom")

    monkeypatch.setattr(s, "claim_dispatch", lambda jid: True)
    monkeypatch.setattr(s, "run_job", fake_run_job)
    monkeypatch.setattr(s, "mark_job_run", lambda *a, **k: None)

    assert s.run_one_job({"id": "j9", "name": "t"}) is False
    assert seen["during"] == ["j9"]
    assert jobs.list_running_jobs(tmp_path) == []
