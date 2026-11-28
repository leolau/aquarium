"""``hermes projects`` — the operator surface (design §14, §17 step 9).

Behaviour contracts: the CLI drives the ``projects_api`` router in process,
so every assertion here exercises the real permission gate end to end. The
acting principal is resolved by the CLI's own seam (patched here, exactly as
a short-lived CLI process owns it), never by bypassing the router.
"""

from __future__ import annotations

import argparse
import json
import sys

import pytest

from hermes_cli import kanban_db, projects_api, projects_cli
from hermes_cli.access import Principal

OWNER = Principal(user_id="leo", display="Leo", role="owner")  # type: ignore[arg-type]


@pytest.fixture
def env(tmp_path, monkeypatch, capsys):
    """Isolated projects + kanban stores and a CLI whose principal seam is
    the enrolled owner. ``_Api`` patches the router's resolution seams
    itself; the tests only stand in for the PrincipalStore lookup."""
    monkeypatch.setenv("HERMES_PROJECTS_DB", str(tmp_path / "projects.db"))
    monkeypatch.setenv("HERMES_KANBAN_DB", str(tmp_path / "kanban.db"))

    async def _resolve(actor):
        assert actor is None
        return OWNER

    async def _enrolled(user_id):
        return set()

    monkeypatch.setattr(projects_cli, "_resolve_principal", _resolve)
    monkeypatch.setattr(projects_api, "_enrolled_profiles", _enrolled)

    def run(*argv: str) -> int:
        parser = argparse.ArgumentParser(prog="hermes")
        subparsers = parser.add_subparsers(dest="command")
        projects_cli.register_projects_subparser(subparsers)
        args = parser.parse_args(["projects", *argv])
        return args.func(args)

    return run, capsys


def _create(run, capsys, tmp_path) -> str:
    """Create the fixture project and return its slug."""
    brief = tmp_path / "brief.md"
    brief.write_text("A weekly digest compiled and emailed each Monday.")
    assert run(
        "create", "Ship the Monday digest — to every subscriber",
        "--description", str(brief),
        "--output", "The Monday digest email",
        "--host-profile", "default",
        "--name", "Monday digest",
        "--json",
    ) == 0
    return json.loads(capsys.readouterr().out)["slug"]


# ---------------------------------------------------------------------------
# create — the §2.2 mandatory contract
# ---------------------------------------------------------------------------


def test_create_refuses_an_unreadable_description(env, tmp_path, capsys):
    run, _capsys = env
    code = run(
        "create", "Ship the Monday digest",
        "--description", str(tmp_path / "missing.md"),
        "--output", "The digest email",
    )
    assert code == 2
    err = capsys.readouterr().err
    assert "--description must be a readable file path" in err


def test_create_happy_path_starts_in_planning(env, tmp_path, capsys):
    run, _capsys = env
    slug = _create(run, capsys, tmp_path)
    assert slug == "monday-digest"


def test_list_and_show_read_the_record_back(env, tmp_path, capsys):
    run, _capsys = env
    slug = _create(run, capsys, tmp_path)

    assert run("list") == 0
    out = capsys.readouterr().out
    assert slug in out
    assert "▣" in out  # one_off glyph
    assert "Ship the Monday digest" in out

    assert run("show", slug, "--json") == 0
    shown = json.loads(capsys.readouterr().out)
    assert shown["goal"].startswith("Ship the Monday digest")
    assert shown["status"] == "planning"
    assert shown["outputs"][0]["title"] == "The Monday digest email"


def test_show_on_an_unknown_slug_fails_as_a_404(env, capsys):
    run, _capsys = env
    assert run("show", "no-such-project") == 1
    assert "not found" in capsys.readouterr().err


# ---------------------------------------------------------------------------
# outputs + guidance — the judgement verbs
# ---------------------------------------------------------------------------


def test_outputs_add_and_list(env, tmp_path, capsys):
    run, _capsys = env
    slug = _create(run, capsys, tmp_path)

    assert run("outputs", slug, "add", "Sample archive", "--optional") == 0
    out = capsys.readouterr().out
    assert "Added output 'Sample archive'" in out

    assert run("outputs", slug) == 0
    out = capsys.readouterr().out
    assert "The Monday digest email" in out
    assert "Sample archive (optional)" in out


def test_outputs_deliver_from_a_card_records_the_card(env, tmp_path, capsys, monkeypatch):
    """Run inside a kanban worker, `outputs deliver` files the delivery
    under the worker's own card and profile — the worker never has to know
    its ids."""
    from hermes_cli import projects_db

    run, _capsys = env
    slug = _create(run, capsys, tmp_path)
    with projects_db.connect_closing() as conn:
        project = projects_db.get_project(conn, slug)
        oid = projects_db.get_project_outputs(conn, project.id)[0]["id"]

    monkeypatch.setenv("HERMES_KANBAN_TASK", "t_card123")
    monkeypatch.setenv("HERMES_PROFILE", "default")
    assert run(
        "outputs", slug, "deliver", oid, "--ref", "https://docs.example/d/1"
    ) == 0
    assert f"Delivered output {oid}." in capsys.readouterr().out

    with projects_db.connect_closing() as conn:
        rows = projects_db.get_output_deliveries(conn, output_id=oid)
    assert len(rows) == 1
    assert rows[0]["task_id"] == "t_card123"
    assert rows[0]["profile"] == "default"
    assert rows[0]["link_kind"] == "url"


def test_outputs_deliver_outside_a_card_sends_no_card(env, tmp_path, capsys, monkeypatch):
    from hermes_cli import projects_db

    run, _capsys = env
    slug = _create(run, capsys, tmp_path)
    with projects_db.connect_closing() as conn:
        project = projects_db.get_project(conn, slug)
        oid = projects_db.get_project_outputs(conn, project.id)[0]["id"]

    monkeypatch.delenv("HERMES_KANBAN_TASK", raising=False)
    assert run("outputs", slug, "deliver", oid, "--ref", "~/out/report.md") == 0
    with projects_db.connect_closing() as conn:
        rows = projects_db.get_output_deliveries(conn, output_id=oid)
    assert rows[0]["task_id"] is None
    assert rows[0]["run_id"] is None


def test_outputs_deliver_a_shared_workdir_file(env, tmp_path, capsys, monkeypatch):
    """A run's shared working dir (``auction-work``) sits under the kanban
    home but outside the board's managed roots — the artifacts read serves
    those paths, so ``deliver`` accepts them too instead of refusing the
    card's natural deliverable location."""
    from hermes_cli import projects_db

    run, _capsys = env
    slug = _create(run, capsys, tmp_path)
    with projects_db.connect_closing() as conn:
        project = projects_db.get_project(conn, slug)
        oid = projects_db.get_project_outputs(conn, project.id)[0]["id"]

    home = tmp_path / "kanban-home"
    ref = home / "auction-work/102126/delivered/run4.xlsx"
    ref.parent.mkdir(parents=True)
    ref.write_bytes(b"workbook")
    monkeypatch.setenv("HERMES_KANBAN_HOME", str(home))

    assert run("outputs", slug, "deliver", oid, "--ref", str(ref)) == 0
    with projects_db.connect_closing() as conn:
        rows = projects_db.get_output_deliveries(conn, output_id=oid)
    assert rows[0]["link_kind"] == "workspace"
    assert rows[0]["link_ref"] == str(ref)


def test_guidance_add_says_next_run(env, tmp_path, capsys):
    run, _capsys = env
    slug = _create(run, capsys, tmp_path)

    assert run("guidance", slug, "add", "Never email before 9am") == 0
    out = capsys.readouterr().out
    assert "applies from the next run" in out

    assert run("guidance", slug) == 0
    out = capsys.readouterr().out
    assert "Never email before 9am" in out


# ---------------------------------------------------------------------------
# cards — including the §10 promotion seam
# ---------------------------------------------------------------------------


def test_card_add_from_todo_promotes(env, tmp_path, monkeypatch, capsys):
    from tests.hermes_cli.test_projects_api_promote import (
        _FakeStore,
        _make_todo,
    )

    run, _capsys = env
    monkeypatch.setattr(
        "hermes_cli.todo_store.default_store",
        lambda mode=None: _FakeStore(_make_todo()),
    )
    slug = _create(run, capsys, tmp_path)

    assert run("card", "add", slug, "Rollout card",
               "--from-todo", "td_1") == 0
    out = capsys.readouterr().out
    assert "promoted from to-do" in out

    from hermes_cli import projects_db

    with projects_db.connect_closing() as conn:
        project = projects_db.get_project(conn, slug)
    with kanban_db.connect_closing(board=project.board_slug) as bconn:
        tasks = kanban_db.list_tasks(bconn, project_id=project.id)
    assert len(tasks) == 1
    card = tasks[0]
    assert card.status == "triage"  # promotion is not dispatch
    assert card.title == "Rollout card"  # the explicit title wins
    assert card.body == "Everything the card should inherit as its body."


# ---------------------------------------------------------------------------
# run + doctor
# ---------------------------------------------------------------------------


def test_score_verb_refuses_without_as_human(env, tmp_path, capsys):
    """The CLI no longer patches the §8.1 gate in automatically: a plain
    `score` is a session-less caller like any agent turn, and writes
    nothing."""
    from hermes_cli import projects_db

    run, _capsys = env
    slug = _create(run, capsys, tmp_path)
    with projects_db.connect_closing() as conn:
        project = projects_db.get_project(conn, slug)
        projects_db.open_project_run(
            conn, project_id=project.id, trigger="manual", profile="default"
        )

    assert run("score", slug, "1", "3", "--note", "too formal") == 1
    err = capsys.readouterr().err
    assert "human act" in err
    assert "--as-human" in err  # the hint names the operator's escape hatch
    with projects_db.connect_closing() as conn:
        run_row = projects_db.get_project_run(conn, project.id, 1)
    assert run_row["score_user"] is None  # nothing was written


def test_score_verb_with_as_human_is_the_operator(env, tmp_path, capsys):
    """`--as-human` is the operator's explicit claim on the human surface;
    with it, the judgement lands."""
    from hermes_cli import projects_db

    run, _capsys = env
    slug = _create(run, capsys, tmp_path)
    with projects_db.connect_closing() as conn:
        project = projects_db.get_project(conn, slug)
        projects_db.open_project_run(
            conn, project_id=project.id, trigger="manual", profile="default"
        )

    assert run("--as-human", "score", slug, "1", "3", "--note", "too formal") == 0
    out = capsys.readouterr().out
    assert "Scored run 1" in out and "3/5" in out and "too formal" in out

    assert run("show", slug) == 0
    assert "score: 3.0 (last 1 runs)" in capsys.readouterr().out


def test_run_dry_without_a_playbook_explains_itself(env, tmp_path, capsys):
    run, _capsys = env
    slug = _create(run, capsys, tmp_path)

    assert run("run", slug, "--dry-run") == 1
    err = capsys.readouterr().err
    assert "no playbook" in err


# ---------------------------------------------------------------------------
# retro proposals + the member activation crossing (§8.2, step 10)
# ---------------------------------------------------------------------------


def test_retro_proposals_land_inactive_and_activate(env, tmp_path, monkeypatch, capsys):
    import io

    from hermes_cli import projects_db

    run, _capsys = env
    slug = _create(run, capsys, tmp_path)
    with projects_db.connect_closing() as conn:
        project = projects_db.get_project(conn, slug)
        projects_db.open_project_run(
            conn, project_id=project.id, trigger="manual", profile="default"
        )

    monkeypatch.setattr(
        sys, "stdin", io.StringIO("Compiled and sent; the tone was too formal.")
    )
    assert run(
        "retro", slug, "1", "--write",
        "--propose", "directive=Never email before 9am",
        "--propose", "skill=Keep the digest conversational.",
    ) == 0
    out = capsys.readouterr().out
    assert "Retro saved for run 1" in out
    assert "proposed directive" in out and "inactive" in out
    assert "recorded skill candidate" in out

    # The proposal shows up in the guidance list, awaiting a member.
    assert run("guidance", slug) == 0
    out = capsys.readouterr().out
    assert "Never email before 9am" in out
    assert "inactive until a member activates" in out
    directive_id = [
        token for token in out.replace("(", " ").replace(")", " ").split()
        if token.startswith("dir_")
    ][0]

    # The operator crosses it in person — and it applies from the next run.
    assert run("--as-human", "guidance", slug, "activate", directive_id) == 0
    out = capsys.readouterr().out
    assert "Activated instruction" in out and "next run" in out

    assert run("guidance", slug) == 0
    out = capsys.readouterr().out
    assert "Never email before 9am" in out
    assert "inactive until a member activates" not in out


def test_retro_refuses_a_malformed_proposal(env, tmp_path, monkeypatch, capsys):
    import io

    from hermes_cli import projects_db

    run, _capsys = env
    slug = _create(run, capsys, tmp_path)
    with projects_db.connect_closing() as conn:
        project = projects_db.get_project(conn, slug)
        projects_db.open_project_run(
            conn, project_id=project.id, trigger="manual", profile="default"
        )

    monkeypatch.setattr(sys, "stdin", io.StringIO("A retro."))
    assert run("retro", slug, "1", "--write", "--propose", "memory=x") == 2
    assert "kind one of" in capsys.readouterr().err


def test_summarise_round_trip(env, tmp_path, monkeypatch, capsys):
    import io

    run, _capsys = env
    slug = _create(run, capsys, tmp_path)

    # Empty stdin is refused — a blank "where this stands" is not a summary.
    monkeypatch.setattr(sys, "stdin", io.StringIO("   "))
    assert run("summarise", slug) == 2
    assert "nothing to write" in capsys.readouterr().err

    monkeypatch.setattr(
        sys, "stdin", io.StringIO("Run 14 waiting on your answer about the tone.")
    )
    assert run("summarise", slug) == 0
    out = capsys.readouterr().out
    assert "Summary updated" in out
    assert "Run 14 waiting on your answer about the tone." in out

    # The rolling summary rides the detail read.
    assert run("show", slug) == 0
    out = capsys.readouterr().out
    assert "where this stands: Run 14 waiting on your answer about the tone." in out


def test_doctor_healthy_box(env, capsys):
    run, _capsys = env
    assert run("doctor") == 0
    assert "healthy" in capsys.readouterr().out


# ---------------------------------------------------------------------------
# archive / restore / delete — the lifecycle verbs (§13, decision 17)
# ---------------------------------------------------------------------------


def test_archive_and_restore_round_trip(env, tmp_path, capsys):
    run, _capsys = env
    slug = _create(run, capsys, tmp_path)

    assert run("archive", slug, "--reason", "done for term", "--json") == 0
    archived = json.loads(capsys.readouterr().out)
    assert archived["archived"] is True
    assert archived["status"] == "archived"

    assert run("restore", slug, "--json") == 0
    restored = json.loads(capsys.readouterr().out)
    assert restored["archived"] is False
    # Re-entry is a decision: paused, never straight back to active.
    assert restored["status"] == "paused"


def test_delete_is_a_human_act_with_a_typed_slug(env, tmp_path, capsys):
    run, _capsys = env
    slug = _create(run, capsys, tmp_path)
    assert run("archive", slug) == 0
    capsys.readouterr()

    # Without --as-human the router refuses the agent-side caller, and the
    # hint names the operator's escape hatch.
    assert run("delete", slug, "--confirm", slug) == 1
    err = capsys.readouterr().err
    assert "human act" in err
    assert "--as-human" in err

    # confirm must equal the slug.
    assert run("--as-human", "delete", slug, "--confirm", "wrong") == 1
    assert "confirm" in capsys.readouterr().err

    assert run("--as-human", "delete", slug, "--confirm", slug, "--json") == 0
    assert json.loads(capsys.readouterr().out) == {"deleted": slug}
    # The record is gone, not shelved.
    assert run("show", slug) == 1


# ---------------------------------------------------------------------------
# create --from-chat — a project started in a private chat
# ---------------------------------------------------------------------------


def _chat_env(tmp_path, monkeypatch, owner="leo"):
    from hermes_cli import projects_chat_api
    from hermes_state import SessionDB

    def _db(profile):
        (tmp_path / profile).mkdir(exist_ok=True)
        return SessionDB(db_path=tmp_path / profile / "state.db")

    db = _db("default")
    db.create_session("s-chat", "web", user_id=owner)
    db.append_message("s-chat", "user", "Hi there")
    db.append_message("s-chat", "assistant", "Hello.")
    db.append_message("s-chat", "user", "Every Monday, send the sales report.")
    db.close()
    monkeypatch.setattr(projects_chat_api, "_session_db", _db)

    async def _name(user_id):
        return {"leo": "Leo"}.get(user_id)

    monkeypatch.setattr(projects_chat_api, "_display_name", _name)
    monkeypatch.setenv("HERMES_SESSION_ID", "s-chat")
    monkeypatch.setenv("HERMES_SESSION_PROFILE", "default")
    monkeypatch.delenv("HERMES_PRINCIPAL_TICKET", raising=False)
    seen = []

    async def _resolve(actor):
        seen.append(actor)
        return OWNER

    monkeypatch.setattr(projects_cli, "_resolve_principal", _resolve)
    return seen


def _create_from_chat(run, tmp_path, *extra):
    brief = tmp_path / "brief.md"
    brief.write_text("A weekly sales report.")
    return run(
        "create", "Send the weekly sales report",
        "--description", str(brief),
        "--output", "The report email",
        "--host-profile", "default",
        "--name", "Weekly sales report",
        "--from-chat", "1",
        "--chat-summary", "Leo asked for a weekly sales report.",
        *extra,
    )


def test_create_from_chat_seeds_the_project_chat_as_the_chats_owner(env, tmp_path, monkeypatch, capsys):
    from hermes_cli import projects_db

    run, _capsys = env
    seen = _chat_env(tmp_path, monkeypatch)
    assert _create_from_chat(run, tmp_path, "--json") == 0
    out = json.loads(capsys.readouterr().out)
    assert seen == ["leo"]
    assert out["quoted_messages"] == 1
    assert out["card"].startswith(f"[project card: {out['slug']}")
    assert out["card"].endswith(" quoted]")
    with projects_db.connect_closing() as conn:
        (row,) = projects_db.get_chat_messages(conn, out["id"])
    assert row["kind"] == "seed" and row["user_id"] == "leo"
    meta = json.loads(row["meta"])
    assert [q["text"] for q in meta["quotes"]] == ["Every Monday, send the sales report."]
    assert "Hello." not in row["content"]


def test_create_from_chat_says_the_quote_is_shared(env, tmp_path, monkeypatch, capsys):
    run, _capsys = env
    _chat_env(tmp_path, monkeypatch)
    assert _create_from_chat(run, tmp_path) == 0
    out = capsys.readouterr().out
    assert "every project member can read them" in out
    assert out.strip().splitlines()[-1].startswith("[project card: weekly-sales-report")


def test_create_from_chat_refuses_another_actor(env, tmp_path, monkeypatch, capsys):
    from hermes_cli import projects_db

    run, _capsys = env
    _chat_env(tmp_path, monkeypatch)
    brief = tmp_path / "brief.md"
    brief.write_text("x")
    assert run(
        "--actor", "ada", "create", "Another", "--description", str(brief),
        "--output", "x", "--host-profile", "default", "--from-chat", "1",
    ) == 2
    assert "--actor must be the chat's owner" in capsys.readouterr().err
    with projects_db.connect_closing() as conn:
        assert projects_db.list_projects(conn) == []


def test_create_from_chat_outside_a_chat_creates_nothing(env, tmp_path, monkeypatch, capsys):
    from hermes_cli import projects_db

    run, _capsys = env
    _chat_env(tmp_path, monkeypatch)
    monkeypatch.delenv("HERMES_SESSION_ID")
    assert _create_from_chat(run, tmp_path) == 2
    assert "no chat" in capsys.readouterr().err
    with projects_db.connect_closing() as conn:
        assert projects_db.list_projects(conn) == []


def _ticket_from_root_for_profile_terminal(tmp_path, monkeypatch, user):
    """The gateway mints under the installation root; a chat on another
    profile runs the terminal with that profile's HERMES_HOME."""
    from hermes_cli import principal_ticket

    root = tmp_path / "root"
    (root / "profiles" / "research").mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(root))
    ticket = principal_ticket.mint(user)
    assert ticket
    monkeypatch.setenv("HERMES_HOME", str(root / "profiles" / "research"))
    monkeypatch.setenv(principal_ticket.ENV_VAR, ticket)


def test_create_from_chat_accepts_the_owners_ticket_on_another_profile(env, tmp_path, monkeypatch, capsys):
    run, _capsys = env
    seen = _chat_env(tmp_path, monkeypatch)
    _ticket_from_root_for_profile_terminal(tmp_path, monkeypatch, "leo")
    assert _create_from_chat(run, tmp_path, "--json") == 0
    assert json.loads(capsys.readouterr().out)["quoted_messages"] == 1
    assert seen == ["leo"]


def test_create_from_chat_refuses_a_ticket_for_someone_else(env, tmp_path, monkeypatch, capsys):
    from hermes_cli import projects_db

    run, _capsys = env
    _chat_env(tmp_path, monkeypatch)
    _ticket_from_root_for_profile_terminal(tmp_path, monkeypatch, "ada")
    assert _create_from_chat(run, tmp_path) == 2
    assert "does not run for the chat's owner" in capsys.readouterr().err
    with projects_db.connect_closing() as conn:
        assert projects_db.list_projects(conn) == []

# ---------------------------------------------------------------------------
# playbook draft — the agent co-creates the plan in the person's draft
# ---------------------------------------------------------------------------


def test_playbook_draft_verbs_edit_only_the_actors_draft(env, tmp_path, capsys):
    run, _capsys = env
    slug = _create(run, capsys, tmp_path)

    assert run("playbook", slug, "draft") == 0
    assert "No working draft" in capsys.readouterr().out

    assert run("playbook", slug, "draft", "set", '{"body": "Compile, then send."}') == 0
    assert run(
        "playbook", slug, "draft", "patch-step", "send", '{"title": "Send it"}'
    ) == 0
    assert run(
        "playbook", slug, "draft", "patch-step", "compile",
        '{"title": "Compile the items"}', "--after", "ghost",
    ) == 1
    assert "no step 'ghost'" in capsys.readouterr().err
    spec = tmp_path / "step.json"
    spec.write_text(json.dumps({"title": "Compile the items"}))
    assert run("playbook", slug, "draft", "patch-step", "compile", str(spec)) == 0
    capsys.readouterr()

    assert run("playbook", slug, "draft", "show") == 0
    out = capsys.readouterr().out
    assert "Draft · leo (from scratch)" in out
    assert "send: Send it" in out and "compile: Compile the items" in out

    assert run("playbook", slug, "draft", "show", "--expected-version", "1") == 0
    capsys.readouterr()
    assert run(
        "playbook", slug, "draft", "remove-step", "send", "--expected-version", "1"
    ) == 1
    assert "changed since you read it" in capsys.readouterr().err

    assert run("playbook", slug, "draft", "save", "--json") == 0
    saved = json.loads(capsys.readouterr().out)
    assert saved["active"] is False
    assert run("playbook", slug, "--json") == 0
    data = json.loads(capsys.readouterr().out)
    assert data["active"] is None
    (rev,) = data["revisions"]
    assert rev["rev"] == saved["rev"] and rev["created_by"] == "leo"
    assert [s["key"] for s in rev["steps"]] == ["send", "compile"]

    assert run("playbook", slug, "draft", "discard") == 1
    assert "no working draft" in capsys.readouterr().err


# ---------------------------------------------------------------------------
# From the agent's terminal under terminal.run_as: hermes-tools
# ---------------------------------------------------------------------------


def _tools_cli():
    import importlib.machinery
    import importlib.util
    from pathlib import Path

    path = Path(__file__).resolve().parents[2] / "deploy/hermes-tools-cli"
    loader = importlib.machinery.SourceFileLoader("hermes_tools_cli_projects", str(path))
    spec = importlib.util.spec_from_loader("hermes_tools_cli_projects", loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def test_hermes_tools_create_from_chat_runs_as_the_chatting_person(env, tmp_path, monkeypatch, capsys):
    """The helper's argv and env, fed to the real CLI: the project is created
    as the ticket's person (the chat owner), never as the owner default."""
    import io

    from hermes_cli import principal_ticket, projects_db

    run, _capsys = env
    seen = _chat_env(tmp_path, monkeypatch)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    ticket = principal_ticket.mint("leo")
    key = (tmp_path / "home" / principal_ticket.KEY_RELPATH).read_bytes().strip()
    cli = _tools_cli()
    argv = ["projects", "create", "Send the weekly sales report", "--description", "-",
            "--output", "The report email", "--from-chat", "1",
            "--chat-summary", "Leo asked for a weekly sales report.", "--json"]
    path = cli.check(argv)
    argv, passed = cli.as_requester(path, argv, ticket, key)
    # Agent Home binds the session id only; the CLI finds the chat's profile.
    monkeypatch.delenv("HERMES_SESSION_PROFILE")
    session_env = cli.session_args(path, dict(__import__("os").environ))
    assert argv[:2] == ["projects", "--actor=leo"] and passed == ticket
    assert session_env == {"HERMES_SESSION_ID": "s-chat"}
    monkeypatch.setenv(principal_ticket.ENV_VAR, passed)
    monkeypatch.setattr("sys.stdin", io.StringIO("A weekly sales report."))
    assert run(*argv[1:]) == 0
    assert seen == ["leo"]
    assert json.loads(capsys.readouterr().out)["quoted_messages"] == 1
    with projects_db.connect_closing() as conn:
        [project] = projects_db.list_projects(conn)
        hosts = [r["profile"] for r in projects_db.get_project_profiles(conn, project.id)
                 if r["role"] == "host"]
    assert hosts == ["default"]


def test_hermes_tools_create_for_someone_elses_chat_is_refused(env, tmp_path, monkeypatch, capsys):
    from hermes_cli import principal_ticket, projects_db

    run, _capsys = env
    _chat_env(tmp_path, monkeypatch)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    ticket = principal_ticket.mint("ada")
    key = (tmp_path / "home" / principal_ticket.KEY_RELPATH).read_bytes().strip()
    cli = _tools_cli()
    argv = ["projects", "create", "Another", "--description", "-", "--output", "o",
            "--from-chat", "1"]
    argv, passed = cli.as_requester(cli.check(argv), argv, ticket, key)
    assert argv[1] == "--actor=ada"
    monkeypatch.setenv(principal_ticket.ENV_VAR, passed)
    monkeypatch.setattr("sys.stdin", __import__("io").StringIO("brief"))
    assert run(*argv[1:]) == 2
    assert "chat's owner" in capsys.readouterr().err
    with projects_db.connect_closing() as conn:
        assert projects_db.list_projects(conn) == []


def test_playbook_draft_step_keys_are_one_path_segment(env, tmp_path, capsys):
    run, _capsys = env
    slug = _create(run, capsys, tmp_path)
    assert run("playbook", slug, "draft", "set", '{"steps": [{"key": "review", "title": "Review"}]}') == 0
    assert run("playbook", slug, "draft", "patch-step", "review#2", '{"title": "Second review"}') == 0
    capsys.readouterr()
    assert run("playbook", slug, "draft", "show", "--json") == 0
    draft = json.loads(capsys.readouterr().out)["draft"]
    assert [(s["key"], s["title"]) for s in draft["steps"]] == [
        ("review", "Review"),
        ("review#2", "Second review"),
    ]


def test_playbook_draft_in_a_chat_turn_acts_only_as_its_person(env, tmp_path, monkeypatch, capsys):
    from hermes_cli import principal_ticket

    run, _capsys = env
    slug = _create(run, capsys, tmp_path)
    monkeypatch.setenv(principal_ticket.ENV_VAR, principal_ticket.mint("leo"))
    assert run("--actor", "ada", "playbook", slug, "draft", "set", '{"body": "x"}') == 2
    assert "--actor must be the person" in capsys.readouterr().err
    monkeypatch.setenv(principal_ticket.ENV_VAR, "forged")
    assert run("playbook", slug, "draft", "set", '{"body": "x"}') == 2
    assert "not valid" in capsys.readouterr().err


def test_playbook_save_reads_the_spec_from_stdin(env, tmp_path, monkeypatch, capsys):
    """The hermes-tools shim turns ``save FILE`` into ``save -`` with the file on stdin."""
    import io

    run, _capsys = env
    slug = _create(run, capsys, tmp_path)
    spec = {"steps": [{"key": "compile", "title": "Compile the report"}]}
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(spec)))
    assert run("playbook", slug, "save", "-", "--json") == 0
    saved = json.loads(capsys.readouterr().out)
    assert saved["active"] is False
    assert run("playbook", slug, "--json") == 0
    (rev,) = json.loads(capsys.readouterr().out)["revisions"]
    assert rev["rev"] == saved["rev"] and [s["key"] for s in rev["steps"]] == ["compile"]
