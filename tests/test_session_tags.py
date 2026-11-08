"""Tests for the session tagging system in SessionDB (schema v18).

Real SQLite under ``tmp_path`` — no HTTP, no mocks. Exercises the tag CRUD
methods and the tag-based session filter added in PR #155.
"""

import time

import pytest


def _make_db(tmp_path):
    """Create a real SessionDB for integration-style tests."""
    from hermes_state import SessionDB

    db = SessionDB(db_path=tmp_path / "test_state.db")
    return db


def _seed_session(db, sid, title=None, source="cli"):
    """Insert a minimal session row for tag attachment."""
    db._conn.execute(
        "INSERT OR IGNORE INTO sessions "
        "(id, source, started_at, title) VALUES (?, ?, ?, ?)",
        (sid, source, time.time(), title),
    )
    db._conn.commit()


class TestAddTag:
    def test_add_tag_creates_tag_and_mapping(self, tmp_path):
        db = _make_db(tmp_path)
        _seed_session(db, "s1")
        tag = db.add_tag_to_session("s1", "bug", color="red")
        assert tag["name"] == "bug"
        assert tag["color"] == "red"
        assert tag["id"]
        # Tag row exists
        tags = db.list_tags()
        assert len(tags) == 1
        assert tags[0]["name"] == "bug"
        # Mapping row exists
        session_tags = db.get_session_tags("s1")
        assert len(session_tags) == 1
        assert session_tags[0]["name"] == "bug"
        db.close()

    def test_add_tag_idempotent(self, tmp_path):
        db = _make_db(tmp_path)
        _seed_session(db, "s1")
        db.add_tag_to_session("s1", "bug")
        db.add_tag_to_session("s1", "bug")  # same name, second call
        # Only one mapping row
        assert len(db.get_session_tags("s1")) == 1
        # Only one tag row
        assert len(db.list_tags()) == 1
        db.close()

    def test_add_tag_case_insensitive(self, tmp_path):
        db = _make_db(tmp_path)
        _seed_session(db, "s1")
        db.add_tag_to_session("s1", "Bug")
        db.add_tag_to_session("s1", "bug")
        # Same tag, not duplicated
        assert len(db.get_session_tags("s1")) == 1
        assert len(db.list_tags()) == 1
        db.close()

    def test_add_tag_invalid_color_falls_back(self, tmp_path):
        db = _make_db(tmp_path)
        _seed_session(db, "s1")
        tag = db.add_tag_to_session("s1", "test", color="not-a-color")
        assert tag["color"] == "blue"
        db.close()

    def test_add_tag_empty_name_raises(self, tmp_path):
        db = _make_db(tmp_path)
        _seed_session(db, "s1")
        with pytest.raises(ValueError):
            db.add_tag_to_session("s1", "  ")
        db.close()


class TestGetSessionTags:
    def test_returns_attached_ordered_by_name(self, tmp_path):
        db = _make_db(tmp_path)
        _seed_session(db, "s1")
        db.add_tag_to_session("s1", "zebra")
        db.add_tag_to_session("s1", "alpha")
        db.add_tag_to_session("s1", "middle")
        tags = db.get_session_tags("s1")
        names = [t["name"] for t in tags]
        assert names == ["alpha", "middle", "zebra"]
        db.close()

    def test_empty_when_no_tags(self, tmp_path):
        db = _make_db(tmp_path)
        _seed_session(db, "s1")
        assert db.get_session_tags("s1") == []
        db.close()


class TestRemoveTag:
    def test_remove_tag_from_session(self, tmp_path):
        db = _make_db(tmp_path)
        _seed_session(db, "s1")
        tag = db.add_tag_to_session("s1", "bug")
        removed = db.remove_tag_from_session("s1", tag["id"])
        assert removed is True
        assert db.get_session_tags("s1") == []
        db.close()

    def test_remove_not_attached_returns_false(self, tmp_path):
        db = _make_db(tmp_path)
        _seed_session(db, "s1")
        removed = db.remove_tag_from_session("s1", "nonexistent-tag-id")
        assert removed is False
        db.close()


class TestDeleteTag:
    def test_delete_tag_cascade(self, tmp_path):
        db = _make_db(tmp_path)
        _seed_session(db, "s1")
        _seed_session(db, "s2")
        tag = db.add_tag_to_session("s1", "bug")
        db.add_tag_to_session("s2", "bug")  # same tag, different session
        # Delete the tag entirely
        deleted = db.delete_tag(tag["id"])
        assert deleted is True
        # Tag row gone
        assert len(db.list_tags()) == 0
        # Mapping rows gone for both sessions
        assert db.get_session_tags("s1") == []
        assert db.get_session_tags("s2") == []
        db.close()

    def test_delete_nonexistent_returns_false(self, tmp_path):
        db = _make_db(tmp_path)
        assert db.delete_tag("nope") is False
        db.close()


class TestCreateTag:
    def test_create_tag_standalone(self, tmp_path):
        """create_tag inserts a tag row with no session association."""
        db = _make_db(tmp_path)
        tag = db.create_tag("bug", color="red")
        assert tag["name"] == "bug"
        assert tag["color"] == "red"
        assert tag["id"]
        # Appears in list_tags with session_count = 0
        tags = db.list_tags()
        assert len(tags) == 1
        assert tags[0]["name"] == "bug"
        assert tags[0]["session_count"] == 0
        db.close()

    def test_create_tag_case_insensitive_dedup(self, tmp_path):
        """Creating a tag with the same name (different case) returns the existing tag."""
        db = _make_db(tmp_path)
        first = db.create_tag("bug", color="red")
        second = db.create_tag("Bug", color="green")
        assert first["id"] == second["id"]
        assert second["color"] == "red"  # original color preserved
        assert len(db.list_tags()) == 1
        db.close()

    def test_create_tag_empty_name_raises(self, tmp_path):
        db = _make_db(tmp_path)
        with pytest.raises(ValueError):
            db.create_tag("   ")
        db.close()

    def test_create_tag_invalid_color_falls_back(self, tmp_path):
        db = _make_db(tmp_path)
        tag = db.create_tag("test", color="not-a-color")
        assert tag["color"] == "blue"
        db.close()


class TestListTags:
    def test_list_tags_with_count(self, tmp_path):
        db = _make_db(tmp_path)
        _seed_session(db, "s1")
        _seed_session(db, "s2")
        _seed_session(db, "s3")
        db.add_tag_to_session("s1", "bug")
        db.add_tag_to_session("s2", "bug")
        db.add_tag_to_session("s3", "feature")
        tags = db.list_tags()
        assert len(tags) == 2
        by_name = {t["name"]: t for t in tags}
        assert by_name["bug"]["session_count"] == 2
        assert by_name["feature"]["session_count"] == 1
        db.close()

    def test_list_tags_empty(self, tmp_path):
        db = _make_db(tmp_path)
        assert db.list_tags() == []
        db.close()


class TestFilterSessionIdsByTags:
    def test_no_tags_returns_none(self, tmp_path):
        db = _make_db(tmp_path)
        assert db.filter_session_ids_by_tags() is None
        assert db.filter_session_ids_by_tags(include_tags=[], exclude_tags=[]) is None
        db.close()

    def test_include_any(self, tmp_path):
        db = _make_db(tmp_path)
        _seed_session(db, "s1")
        _seed_session(db, "s2")
        _seed_session(db, "s3")
        db.add_tag_to_session("s1", "bug")
        db.add_tag_to_session("s2", "feature")
        db.add_tag_to_session("s3", "bug")
        ids = set(db.filter_session_ids_by_tags(include_tags=["bug"], match="any"))
        assert ids == {"s1", "s3"}
        db.close()

    def test_include_all(self, tmp_path):
        db = _make_db(tmp_path)
        _seed_session(db, "s1")
        _seed_session(db, "s2")
        _seed_session(db, "s3")
        db.add_tag_to_session("s1", "bug")
        db.add_tag_to_session("s1", "urgent")
        db.add_tag_to_session("s2", "bug")
        db.add_tag_to_session("s3", "urgent")
        ids = set(db.filter_session_ids_by_tags(
            include_tags=["bug", "urgent"], match="all"
        ))
        assert ids == {"s1"}
        db.close()

    def test_exclude_only(self, tmp_path):
        db = _make_db(tmp_path)
        _seed_session(db, "s1")
        _seed_session(db, "s2")
        _seed_session(db, "s3")
        db.add_tag_to_session("s1", "bug")
        # s2 and s3 have no tags
        ids = set(db.filter_session_ids_by_tags(exclude_tags=["bug"]))
        assert "s1" not in ids
        assert "s2" in ids
        assert "s3" in ids
        db.close()

    def test_include_plus_exclude(self, tmp_path):
        db = _make_db(tmp_path)
        _seed_session(db, "s1")
        _seed_session(db, "s2")
        _seed_session(db, "s3")
        db.add_tag_to_session("s1", "bug")
        db.add_tag_to_session("s1", "urgent")
        db.add_tag_to_session("s2", "bug")
        db.add_tag_to_session("s3", "bug")
        db.add_tag_to_session("s3", "urgent")
        # Include "bug" but exclude "urgent"
        ids = set(db.filter_session_ids_by_tags(
            include_tags=["bug"], exclude_tags=["urgent"], match="any"
        ))
        assert "s2" in ids  # has "bug", not "urgent"
        assert "s1" not in ids  # has "urgent" → excluded
        assert "s3" not in ids  # has "urgent" → excluded
        db.close()


class TestGetTagsForSessions:
    def test_bulk_matches_per_session_lookup(self, tmp_path):
        db = _make_db(tmp_path)
        _seed_session(db, "s1")
        _seed_session(db, "s2")
        _seed_session(db, "s3")
        db.add_tag_to_session("s1", "bug", color="red")
        db.add_tag_to_session("s1", "urgent")
        db.add_tag_to_session("s2", "bug", color="red")
        # s3 has no tags at all.
        by_session = db.get_tags_for_sessions(["s1", "s2", "s3"])
        assert {t["name"] for t in by_session["s1"]} == {"bug", "urgent"}
        assert {t["name"] for t in by_session["s2"]} == {"bug"}
        # A session with no tags is simply absent, not an empty list.
        assert "s3" not in by_session
        db.close()

    def test_empty_input_returns_empty_dict(self, tmp_path):
        db = _make_db(tmp_path)
        assert db.get_tags_for_sessions([]) == {}
        db.close()

    def test_unknown_session_id_is_absent_not_erroring(self, tmp_path):
        db = _make_db(tmp_path)
        _seed_session(db, "s1")
        db.add_tag_to_session("s1", "bug")
        by_session = db.get_tags_for_sessions(["s1", "does-not-exist"])
        assert "s1" in by_session
        assert "does-not-exist" not in by_session
        db.close()


class TestSchemaMigration:
    def test_tag_tables_exist_after_init(self, tmp_path):
        """Tag tables are created on a fresh DB."""
        db = _make_db(tmp_path)
        # Tables exist
        cursor = db._conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN "
            "('session_tags', 'session_tag_map')"
        )
        names = {r[0] for r in cursor.fetchall()}
        assert "session_tags" in names
        assert "session_tag_map" in names
        # Tag tables arrived in v18; later migrations keep them.
        row = db._conn.execute("SELECT version FROM schema_version LIMIT 1").fetchone()
        assert row[0] >= 18
        db.close()
