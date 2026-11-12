"""Scheduled jobs and project runs act as the person who owns them (FG-38 P3).

A job records whose it is when created; its runs bind that person as the
agent's principal, so what they read is what that person may read and what
they collect is theirs. A named owner who is gone refuses the run rather
than falling back to anyone else. The owner lookup is exercised against a
real Postgres.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
import json
import sys
from types import SimpleNamespace

import asyncpg
import pytest

import cron.scheduler as sched
from cron import jobs as cron_jobs
from hermes_cli.access import Principal, PrincipalStore
from hermes_cli.datastore import get_store, initialize_supabase_app
from tests.hermes_cli.test_account_owners_e2e import postgres_dsn  # noqa: F401
from tools import access_policy


@pytest.fixture
def cron_home(tmp_path, monkeypatch):
    monkeypatch.setattr(cron_jobs, "CRON_DIR", tmp_path / "cron")
    monkeypatch.setattr(cron_jobs, "JOBS_FILE", tmp_path / "cron" / "jobs.json")
    monkeypatch.setattr(cron_jobs, "OUTPUT_DIR", tmp_path / "cron" / "output")
    return tmp_path


def test_owner_is_stored_once_and_cannot_be_changed(cron_home):
    job = cron_jobs.create_job(prompt="brief", schedule="every 1h", owner_user_id=" sam ")
    assert cron_jobs.get_job(job["id"])["owner_user_id"] == "sam"
    with pytest.raises(ValueError):
        cron_jobs.update_job(job["id"], {"owner_user_id": "leo"})
    assert cron_jobs.get_job(job["id"])["owner_user_id"] == "sam"


def test_a_job_without_a_known_creator_has_no_owner_field(cron_home):
    job = cron_jobs.create_job(prompt="brief", schedule="every 1h")
    assert "owner_user_id" not in cron_jobs.get_job(job["id"])


def test_the_cron_tool_files_the_job_under_the_person_chatting(cron_home):
    from tools.cronjob_tools import cronjob

    with access_policy.acting_as("sam", "member"):
        out = cronjob(action="create", prompt="summarise my tenders", schedule="every 1d")
    assert json.loads(out)["success"] is True
    [job] = cron_jobs.list_jobs(include_disabled=True)
    assert job["owner_user_id"] == "sam"


class _Agent:
    built: list = []

    def __init__(self, *_a, **kw):
        _Agent.built.append(kw)

    def run_conversation(self, *_a, **_kw):
        return {"final_response": "done", "messages": []}

    def get_activity_summary(self):
        return {"seconds_since_activity": 0.0}


@pytest.fixture
def agent_stubs(monkeypatch):
    _Agent.built = []
    fake_mod = type(sys)("run_agent")
    fake_mod.AIAgent = _Agent
    monkeypatch.setitem(sys.modules, "run_agent", fake_mod)
    from hermes_cli import runtime_provider

    monkeypatch.setattr(
        runtime_provider,
        "resolve_runtime_provider",
        lambda **_kw: {
            "provider": "test", "api_key": "k",
            "base_url": "http://test.local", "api_mode": "chat_completions",
        },
    )
    monkeypatch.setattr(sched, "_build_job_prompt", lambda job, prerun_script=None: "hi")
    monkeypatch.setattr(sched, "_resolve_origin", lambda job: None)
    monkeypatch.setattr(sched, "_resolve_delivery_target", lambda job: None)
    monkeypatch.setattr(sched, "_resolve_cron_enabled_toolsets", lambda job, cfg: None)
    monkeypatch.setattr(sched, "_start_cron_trace", lambda *a, **k: (None, None, None))
    monkeypatch.setenv("HERMES_CRON_TIMEOUT", "0")
    import dotenv

    monkeypatch.setattr(dotenv, "load_dotenv", lambda *_a, **_kw: True)
    return _Agent


def test_a_run_binds_the_jobs_owner_as_the_agent(agent_stubs, monkeypatch):
    sam = Principal(user_id="sam", display="Sam", role="member")
    asked = []
    monkeypatch.setattr(
        sched, "resolve_run_principal", lambda uid, **kw: (asked.append(uid), (sam, None))[1]
    )

    ok, _doc, _resp, error = sched.run_job(
        {"id": "j1", "name": "tenders", "owner_user_id": "sam", "schedule_display": "manual"}
    )

    assert ok, error
    assert asked == ["sam"]
    [built] = agent_stubs.built
    assert (built["internal_user_id"], built["internal_user_role"]) == ("sam", "member")


def test_a_refused_owner_never_starts_the_agent(agent_stubs, monkeypatch):
    monkeypatch.setattr(sched, "resolve_run_principal", lambda uid, **kw: (None, "gone"))

    ok, doc, _resp, error = sched.run_job(
        {"id": "j2", "name": "tenders", "owner_user_id": "gone", "schedule_display": "manual"}
    )

    assert not ok and error == "gone" and "Not run" in doc
    assert agent_stubs.built == []


def test_a_project_run_acts_as_the_project_owner(monkeypatch):
    from agent import seeded_session
    from hermes_cli import projects_run

    sam = Principal(user_id="sam", display="Sam", role="member")
    homes = []
    monkeypatch.setattr(
        sched,
        "resolve_run_principal",
        lambda uid, hermes_home=None: (
            homes.append(hermes_home),
            (sam, None) if uid == "sam" else (None, "no"),
        )[1],
    )
    from hermes_cli import profiles

    monkeypatch.setattr(profiles, "get_profile_dir", lambda name: Path(f"/homes/{name}"))
    seen = []
    monkeypatch.setattr(
        seeded_session,
        "spawn_seeded_session",
        lambda *a, **kw: (seen.append(kw), SimpleNamespace(error=None, timed_out=False))[1],
    )
    project = SimpleNamespace(id="p1", slug="tenders", owner_user_id="sam")
    steps = [{"key": "a", "title": "Collect"}]

    out = projects_run._default_spawn_inline(
        project=project, run={"run_no": 1, "profile": "worker"}, guidance="g",
        inline_steps=steps,
    )
    assert out["error"] is None
    assert homes == [Path("/homes/worker")], "checked where the run happens"
    assert (seen[0]["internal_user_id"], seen[0]["internal_user_role"]) == ("sam", "member")

    gone = SimpleNamespace(id="p2", slug="old", owner_user_id="gone")
    out = projects_run._default_spawn_inline(
        project=gone, run={"run_no": 1}, guidance="g", inline_steps=steps
    )
    assert out == {"session_id": None, "error": "no"} and len(seen) == 1


async def _people(dsn: str) -> None:
    conn = await asyncpg.connect(dsn, ssl=False)
    try:
        await conn.execute("DROP SCHEMA IF EXISTS app_prod CASCADE")
        await initialize_supabase_app(conn)
    finally:
        await conn.close()
    config = {"datastore": {"supabase_app": {"dsn": dsn}}}
    people = PrincipalStore(get_store("supabase-app", "prod", config=config))
    await people.enroll("leo", display="Leo", role="owner")
    await people.enroll("sam", display="Sam")
    await people.enroll("gone", display="Gone")
    conn = await get_store("supabase-app", "prod", config=config).connect()
    try:
        await conn.execute("UPDATE principals SET active = FALSE WHERE user_id = 'gone'")
    finally:
        await conn.close()


def test_owner_lookup_against_postgres(postgres_dsn, monkeypatch):  # noqa: F811
    asyncio.run(_people(postgres_dsn))
    monkeypatch.setattr(
        sched, "load_config", lambda: {"datastore": {"supabase_app": {"dsn": postgres_dsn}}}
    )

    person, refused = sched.resolve_run_principal("sam")
    assert refused is None and (person.user_id, person.role) == ("sam", "member")

    for who in ("gone", "nobody"):
        person, refused = sched.resolve_run_principal(who)
        assert person is None and who in refused

    person, refused = sched.resolve_run_principal(None)  # a job from before owners
    assert refused is None and (person.user_id, person.role) == ("leo", "owner")


def test_lookup_also_works_from_inside_a_running_loop(postgres_dsn, monkeypatch):  # noqa: F811
    asyncio.run(_people(postgres_dsn))
    monkeypatch.setattr(
        sched, "load_config", lambda: {"datastore": {"supabase_app": {"dsn": postgres_dsn}}}
    )

    async def inside():
        return sched.resolve_run_principal("sam")

    person, refused = asyncio.run(inside())
    assert refused is None and person.user_id == "sam"


def test_no_people_store_means_a_single_user_install(monkeypatch):
    monkeypatch.setattr(sched, "load_config", lambda: {})
    assert sched.resolve_run_principal(None) == (None, None)
    assert sched.resolve_run_principal("sam") == (None, None)


def test_a_people_store_that_fails_to_open_refuses_a_named_owner(monkeypatch):
    from hermes_cli import datastore

    def broken(*_a, **_kw):
        raise RuntimeError("bad datastore config")

    monkeypatch.setattr(datastore, "get_store", broken)
    person, refused = sched.resolve_run_principal("sam")
    assert person is None and "sam" in refused, "a named owner never runs as nobody"
    assert sched.resolve_run_principal(None) == (None, None)


def test_a_refused_owner_runs_no_script_either(monkeypatch, tmp_path):
    ran = tmp_path / "ran"
    script = tmp_path / "job.sh"
    script.write_text(f"#!/bin/sh\ntouch {ran}\necho hi\n")
    script.chmod(0o755)
    monkeypatch.setattr(sched, "resolve_run_principal", lambda uid, **kw: (None, "gone"))
    job = {"id": "j", "name": "watch", "no_agent": True, "script": str(script),
           "owner_user_id": "gone"}
    ok, _doc, _final, err = sched.run_job(job)
    assert (ok, err) == (False, "gone") and not ran.exists()


def test_the_owner_is_checked_in_the_profile_the_run_uses(
    postgres_dsn, monkeypatch, tmp_path  # noqa: F811
):
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    homes = {}
    for name in ("worker", "elsewhere"):
        homes[name] = tmp_path / name
        homes[name].mkdir()
        (homes[name] / "config.yaml").write_text(
            f"datastore:\n  supabase_app:\n    dsn: {postgres_dsn}\n"
        )
    token = set_hermes_home_override(str(homes["worker"]))
    try:
        asyncio.run(_people(postgres_dsn))  # Sam is enrolled in "worker" only
    finally:
        reset_hermes_home_override(token)
    person, refused = sched.resolve_run_principal("sam", hermes_home=homes["worker"])
    assert refused is None and person.user_id == "sam"
    person, refused = sched.resolve_run_principal("sam", hermes_home=homes["elsewhere"])
    assert person is None and refused, "enrolment elsewhere grants nothing here"
