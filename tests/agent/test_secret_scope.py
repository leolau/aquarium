"""Tests for the profile-scoped credential primitive (Workstream A / Phase 2)."""
import pytest

from agent import secret_scope as ss


@pytest.fixture(autouse=True)
def _reset_multiplex():
    """Ensure each test starts and ends with multiplexing off (it's a global)."""
    ss.set_multiplex_active(False)
    yield
    ss.set_multiplex_active(False)


class TestMultiplexInactiveBackwardCompat:
    """Default deployment: get_secret transparently reads os.environ."""

    def test_reads_environ(self, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
        assert ss.get_secret("ANTHROPIC_API_KEY") == "sk-test"

    def test_missing_returns_default(self, monkeypatch):
        monkeypatch.delenv("NOPE_KEY", raising=False)
        assert ss.get_secret("NOPE_KEY") is None
        assert ss.get_secret("NOPE_KEY", "fallback") == "fallback"

    def test_no_raise_without_scope(self, monkeypatch):
        monkeypatch.delenv("SOME_KEY", raising=False)
        # multiplex off => unscoped read is fine, returns default
        assert ss.get_secret("SOME_KEY") is None


class TestMultiplexActiveFailClosed:
    """Multiplex on: an unscoped secret read raises instead of leaking."""

    def test_unscoped_read_raises(self, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-leaky")
        ss.set_multiplex_active(True)
        with pytest.raises(ss.UnscopedSecretError):
            ss.get_secret("ANTHROPIC_API_KEY")

    def test_scoped_read_uses_scope_not_environ(self, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-from-environ")
        ss.set_multiplex_active(True)
        token = ss.set_secret_scope({"ANTHROPIC_API_KEY": "sk-from-scope"})
        try:
            assert ss.get_secret("ANTHROPIC_API_KEY") == "sk-from-scope"
        finally:
            ss.reset_secret_scope(token)

    def test_scoped_missing_key_returns_default_not_environ(self, monkeypatch):
        # Even though the value exists in os.environ, a scope is authoritative:
        # an absent scope key must NOT fall through to the (cross-profile) env.
        monkeypatch.setenv("OPENAI_API_KEY", "sk-other-profile")
        ss.set_multiplex_active(True)
        token = ss.set_secret_scope({"ANTHROPIC_API_KEY": "sk-mine"})
        try:
            assert ss.get_secret("OPENAI_API_KEY") is None
            assert ss.get_secret("OPENAI_API_KEY", "d") == "d"
        finally:
            ss.reset_secret_scope(token)

    def test_global_env_still_reads_environ_under_multiplex(self, monkeypatch):
        monkeypatch.setenv("HERMES_HOME", "/opt/data")
        ss.set_multiplex_active(True)
        # No scope, multiplex on — but HERMES_HOME is global, so no raise.
        assert ss.get_secret("HERMES_HOME") == "/opt/data"

    def test_box_wide_gotrue_credentials_are_global(self, monkeypatch):
        # FG-28 D2: one GoTrue per box, so a profile scope with no Supabase
        # .env of its own still reaches it (activation in that profile works).
        names = (
            "SUPABASE_URL",
            "SUPABASE_SERVICE_ROLE_KEY",
            "SUPABASE_ANON_KEY",
            "SUPABASE_JWT_SECRET",
        )
        for name in names:
            monkeypatch.setenv(name, f"box-{name}")
        ss.set_multiplex_active(True)
        token = ss.set_secret_scope({"ANTHROPIC_API_KEY": "sk-hr"})
        try:
            for name in names:
                assert ss.get_secret(name) == f"box-{name}"
        finally:
            ss.reset_secret_scope(token)

    def test_kanban_prefix_is_global(self, monkeypatch):
        monkeypatch.setenv("HERMES_KANBAN_DB", "/x/kanban.db")
        ss.set_multiplex_active(True)
        assert ss.get_secret("HERMES_KANBAN_DB") == "/x/kanban.db"


class TestScopeIsolation:
    """Two scopes never see each other's secrets."""

    def test_nested_scopes_restore(self):
        ss.set_multiplex_active(True)
        t1 = ss.set_secret_scope({"K": "a"})
        try:
            assert ss.get_secret("K") == "a"
            t2 = ss.set_secret_scope({"K": "b"})
            try:
                assert ss.get_secret("K") == "b"
            finally:
                ss.reset_secret_scope(t2)
            assert ss.get_secret("K") == "a"
        finally:
            ss.reset_secret_scope(t1)


class TestEnvFileParsing:
    """load_env_file parses without mutating os.environ."""

    def test_parses_basic(self, tmp_path):
        env = tmp_path / ".env"
        env.write_text(
            "# comment\n"
            "ANTHROPIC_API_KEY=sk-abc\n"
            "export OPENAI_API_KEY=sk-def\n"
            'QUOTED="quoted-value"\n'
            "SINGLE='single'\n"
            "\n"
            "BAD_LINE_NO_EQUALS\n"
        )
        out = ss.load_env_file(env)
        assert out == {
            "ANTHROPIC_API_KEY": "sk-abc",
            "OPENAI_API_KEY": "sk-def",
            "QUOTED": "quoted-value",
            "SINGLE": "single",
        }

    def test_does_not_mutate_environ(self, tmp_path, monkeypatch):
        monkeypatch.delenv("ZZZ_KEY", raising=False)
        env = tmp_path / ".env"
        env.write_text("ZZZ_KEY=secret\n")
        ss.load_env_file(env)
        import os
        assert "ZZZ_KEY" not in os.environ

    def test_missing_file_returns_empty(self, tmp_path):
        assert ss.load_env_file(tmp_path / "nope.env") == {}

    def test_build_profile_secret_scope(self, tmp_path):
        (tmp_path / ".env").write_text("ANTHROPIC_API_KEY=sk-profile\n")
        assert ss.build_profile_secret_scope(tmp_path) == {
            "ANTHROPIC_API_KEY": "sk-profile"
        }


class TestEnvironHome:
    """A process that declares whose credentials os.environ holds (the
    dashboard) keeps reading them for that profile, and only that profile."""

    @pytest.fixture(autouse=True)
    def _reset_environ_home(self):
        ss.set_environ_home(None)
        yield
        ss.set_environ_home(None)

    def test_own_profile_reads_environ_under_multiplex(self, tmp_path, monkeypatch):
        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-own")
        ss.set_environ_home(tmp_path)
        ss.set_multiplex_active(True)
        assert ss.get_secret("ANTHROPIC_API_KEY") == "sk-own"

    def test_another_profile_home_without_its_scope_fails_closed(self, tmp_path, monkeypatch):
        from hermes_constants import reset_hermes_home_override, set_hermes_home_override

        hr = tmp_path / "profiles" / "hr"
        hr.mkdir(parents=True)
        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-own")
        ss.set_environ_home(tmp_path)
        ss.set_multiplex_active(True)
        token = set_hermes_home_override(str(hr))
        try:
            with pytest.raises(ss.UnscopedSecretError):
                ss.get_secret("ANTHROPIC_API_KEY")
        finally:
            reset_hermes_home_override(token)

    def test_undeclared_process_fails_every_unscoped_read(self, tmp_path, monkeypatch):
        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-own")
        ss.set_multiplex_active(True)
        with pytest.raises(ss.UnscopedSecretError):
            ss.get_secret("ANTHROPIC_API_KEY")

    @pytest.mark.parametrize(
        "name",
        [
            "HERMES_DASHBOARD_SUPABASE_ANON_KEY",
            "HERMES_DASHBOARD_SUPABASE_JWT_SECRET",
            "GOTRUE_JWT_SECRET",
        ],
    )
    def test_dashboard_supabase_aliases_are_box_wide(self, monkeypatch, name):
        monkeypatch.setenv(name, "box-value")
        ss.set_multiplex_active(True)
        token = ss.set_secret_scope({name: "profile-value"})
        try:
            assert ss.get_secret(name) == "box-value"
        finally:
            ss.reset_secret_scope(token)


class TestDeploymentDatabaseUrlFallback:
    """The box's one Postgres DSN, set by the unit file, reaches every profile
    whose own .env names none; a DSN loaded from a profile .env never does."""

    @pytest.fixture(autouse=True)
    def _reset_env_file_keys(self):
        saved = set(ss._ENV_FILE_KEYS)
        ss._ENV_FILE_KEYS.discard("DATABASE_URL")
        yield
        ss._ENV_FILE_KEYS.clear()
        ss._ENV_FILE_KEYS.update(saved)

    def test_unit_file_dsn_fills_a_scope_without_one(self, monkeypatch):
        monkeypatch.setenv("DATABASE_URL", "postgresql://box")
        ss.set_multiplex_active(True)
        token = ss.set_secret_scope({"ANTHROPIC_API_KEY": "sk-mine"})
        try:
            assert ss.expand_env_ref("DATABASE_URL") == "postgresql://box"
            assert ss.get_secret("DATABASE_URL") == "postgresql://box"
        finally:
            ss.reset_secret_scope(token)

    def test_profile_dsn_wins_over_unit_file(self, monkeypatch):
        monkeypatch.setenv("DATABASE_URL", "postgresql://box")
        token = ss.set_secret_scope({"DATABASE_URL": "postgresql://hr"})
        try:
            assert ss.expand_env_ref("DATABASE_URL") == "postgresql://hr"
            assert ss.get_secret("DATABASE_URL") == "postgresql://hr"
        finally:
            ss.reset_secret_scope(token)

    def test_dsn_from_another_profiles_env_file_does_not_cross(self, monkeypatch):
        monkeypatch.setenv("DATABASE_URL", "postgresql://default-profile")
        ss.note_env_file_keys(["DATABASE_URL"])
        token = ss.set_secret_scope({})
        try:
            assert ss.expand_env_ref("DATABASE_URL") is None
            assert ss.get_secret("DATABASE_URL") is None
        finally:
            ss.reset_secret_scope(token)

    def test_other_unit_file_secrets_still_do_not_cross(self, monkeypatch):
        monkeypatch.setenv("OPENAI_API_KEY", "sk-unit-file")
        token = ss.set_secret_scope({})
        try:
            assert ss.expand_env_ref("OPENAI_API_KEY") is None
            assert ss.get_secret("OPENAI_API_KEY") is None
        finally:
            ss.reset_secret_scope(token)

    def test_profile_scope_expands_config_dsn_e2e(self, tmp_path, monkeypatch):
        """A fresh install: DSN only in the unit file, profile .env empty."""
        from agent.profile_runtime import profile_runtime_scope
        from hermes_cli.datastore import get_store

        (tmp_path / ".env").write_text("")
        (tmp_path / "config.yaml").write_text(
            "datastore:\n  mode: prod\n  supabase_app:\n    dsn: ${DATABASE_URL}\n"
        )
        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        monkeypatch.setenv("DATABASE_URL", "postgresql://box")
        with profile_runtime_scope(tmp_path):
            store = get_store("supabase-app")
        assert store.dsn == "postgresql://box"
