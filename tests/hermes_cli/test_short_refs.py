"""Short-ref registry (FG-36): parsing, creation-order numbering, and
uniqueness under concurrent writers on one box."""

from __future__ import annotations

import multiprocessing
import sqlite3

import pytest

from hermes_cli import short_refs
from hermes_cli.short_refs import RefItem


@pytest.fixture
def root(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_PROJECTS_DB", str(tmp_path / "projects.db"))
    monkeypatch.setenv("HERMES_KANBAN_DB", str(tmp_path / "kanban.db"))
    return tmp_path


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "text, kind, num, run",
    [
        ("P12", "P", 12, None),
        ("p12", "P", 12, None),
        (" t345 ", "T", 345, None),
        ("P12-R3", "P", 12, 3),
        ("p12-r3", "P", 12, 3),
        ("C1024", "C", 1024, None),
        ("D88", "D", 88, None),
        ("m512", "M", 512, None),
    ],
)
def test_parse_is_case_insensitive_and_round_trips(text, kind, num, run):
    parsed = short_refs.parse_ref(text)
    assert parsed is not None
    assert (parsed.kind, parsed.num, parsed.run_no) == (kind, num, run)
    assert short_refs.parse_ref(str(parsed)) == parsed
    assert str(parsed) == str(parsed).upper()


@pytest.mark.parametrize(
    "text",
    ["", "P", "P0", "P012", "P12-R0", "P12-R03", "T12-R3", "X12", "R3",
     "PP12", "P-12", "P12R3", "P1.5", "t_1a2b3c4d", "P12 extra"],
)
def test_parse_rejects_non_refs_and_leading_zeros(text):
    assert short_refs.parse_ref(text) is None


def test_refs_found_in_text_are_word_bounded():
    found = short_refs.REF_IN_TEXT_RE.findall("see P12, t345 and P12-R3 not MP3 or T1000x")
    assert [f.upper() for f in found] == ["P12", "T345", "P12-R3"]


def test_run_ref_derives_from_project_ref_and_run_no():
    assert short_refs.run_ref("P12", 3) == "P12-R3"
    assert short_refs.run_ref(None, 3) is None
    assert short_refs.run_ref("P12", None) is None


# ---------------------------------------------------------------------------
# Allocation
# ---------------------------------------------------------------------------


def test_registry_lives_next_to_the_shared_projects_db(root):
    assert short_refs.registry_path() == root / "short_refs.db"


def test_assign_is_idempotent_and_stable(root):
    first = short_refs.assign("P", "proj_a", created_at=10)
    again = short_refs.assign("P", "proj_a", created_at=99)
    other = short_refs.assign("P", "proj_b", created_at=5)
    assert first == again
    assert first != other
    assert short_refs.lookup(first.lower()).internal_id == "proj_a"


def test_each_kind_has_its_own_sequence(root):
    p = short_refs.parse_ref(short_refs.assign("P", "x"))
    t = short_refs.parse_ref(short_refs.assign("T", "x"))
    assert (p.kind, t.kind) == ("P", "T")
    assert p.num == t.num == 1


def test_profile_scoped_kinds_record_and_require_the_profile(root):
    with pytest.raises(ValueError):
        short_refs.assign("C", "sess_1")
    a = short_refs.assign("C", "sess_1", profile="alice")
    b = short_refs.assign("C", "sess_1", profile="bob")
    assert a != b  # same id in two profiles is two chats
    assert short_refs.lookup(a).profile == "alice"
    assert short_refs.lookup(b).profile == "bob"
    # Box-wide kinds never carry a profile.
    assert short_refs.lookup(short_refs.assign("P", "p", profile="alice")).profile is None


def test_ensure_refs_numbers_a_batch_in_creation_order(root):
    refs = short_refs.ensure_refs(
        "T",
        [RefItem("t_c", 30), RefItem("t_a", 10), RefItem("t_b", 20)],
    )
    nums = {k: short_refs.parse_ref(v).num for k, v in refs.items()}
    assert nums["t_a"] < nums["t_b"] < nums["t_c"]
    # A second call is a pure read: same answers, no new numbers.
    assert short_refs.ensure_refs("T", [RefItem("t_b", 0)]) == {"t_b": refs["t_b"]}


def test_lookup_of_unknown_or_malformed_ref_is_none(root):
    assert short_refs.lookup("P999") is None
    assert short_refs.lookup("not-a-ref") is None


def _assign_many(args):
    db, worker, n = args
    import os

    os.environ["HERMES_PROJECTS_DB"] = db
    from hermes_cli import short_refs as sr

    return [sr.assign("T", f"t_{worker}_{i}") for i in range(n)]


def test_concurrent_processes_never_share_a_number(root):
    db = str(root / "projects.db")
    short_refs.connect().close()
    ctx = multiprocessing.get_context("spawn")
    with ctx.Pool(4) as pool:
        results = pool.map(_assign_many, [(db, w, 25) for w in range(4)])
    refs = [r for batch in results for r in batch]
    assert len(refs) == len(set(refs)) == 100
    nums = sorted(short_refs.parse_ref(r).num for r in refs)
    assert nums == list(range(1, 101))


def test_the_registry_refuses_a_duplicate_number(root):
    short_refs.assign("P", "a")
    conn = short_refs.connect()
    try:
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO short_refs (kind, num, internal_id, assigned_at) "
                "VALUES ('P', 1, 'b', 0)"
            )
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Backfill — existing items, numbered once in creation order
# ---------------------------------------------------------------------------


def _seed_projects(rows):
    from hermes_cli import projects_db

    with projects_db.connect_closing() as conn:
        for pid, slug, created in rows:
            conn.execute(
                "INSERT INTO projects (id, slug, name, status, created_at) "
                "VALUES (?, ?, ?, 'active', ?)",
                (pid, slug, slug, created),
            )
        conn.commit()


def test_backfill_numbers_existing_projects_oldest_first_once(root):
    _seed_projects([("p_new", "new", 300), ("p_old", "old", 100), ("p_mid", "mid", 200)])
    added = short_refs.backfill("P")
    assert added == 3
    assert short_refs.lookup("P1").internal_id == "p_old"
    assert short_refs.lookup("P2").internal_id == "p_mid"
    assert short_refs.lookup("P3").internal_id == "p_new"
    assert short_refs.backfill("P") == 0


def test_first_touch_backfills_before_numbering_a_new_item(root):
    _seed_projects([("p_old", "old", 100)])
    # A brand-new project created after the upgrade still comes after the
    # projects that existed before it.
    assert short_refs.assign("P", "p_fresh") == "P2"
    assert short_refs.lookup("P1").internal_id == "p_old"


def test_backfill_numbers_existing_project_cards(root):
    from hermes_cli import kanban_db, projects_db

    with projects_db.connect_closing() as conn:
        pid = projects_db.create_project(conn, name="Digest")
    # Cards made before the registry existed (no assign call).
    with kanban_db.connect_closing() as bconn:
        for i, created in enumerate((50, 10, 30)):
            bconn.execute(
                "INSERT INTO tasks (id, title, status, created_at, project_id) "
                "VALUES (?, ?, 'todo', ?, ?)",
                (f"t_{i}", f"card {i}", created, pid),
            )
        bconn.execute(
            "INSERT INTO tasks (id, title, status, created_at) "
            "VALUES ('t_loose', 'not a project card', 'todo', 1)"
        )
        bconn.commit()
    assert short_refs.backfill("T") == 3
    order = [short_refs.lookup(f"T{n}").internal_id for n in (1, 2, 3)]
    assert order == ["t_1", "t_2", "t_0"]
    assert short_refs.lookup("T4") is None
