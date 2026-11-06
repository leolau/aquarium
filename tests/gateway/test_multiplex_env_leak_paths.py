"""FG-28 task 1: does a multiplexed process resolve one profile's credentials
for another, through paths that read ``os.environ`` directly?

These drive the real files-on-disk paths — a profile home with its own ``.env``
and ``config.yaml``, entered through ``profile_runtime_scope`` — rather than the
already-migrated ``get_secret`` seams covered by
``test_multiplex_credential_isolation.py``. Each class below is a leak that was
reproduced before it was closed.
"""
import importlib
import os
import subprocess
import sys

import pytest

from agent.profile_runtime import profile_runtime_scope


def _ss():
    """The live ``agent.secret_scope`` module.

    Resolved per call rather than bound at import: other suites reload shared
    modules, and production code imports this one inside the function bodies, so
    a module-level alias here can end up setting the multiplex flag on an object
    nothing reads.
    """
    return importlib.import_module("agent.secret_scope")


@pytest.fixture(autouse=True)
def _multiplex_off():
    _ss().set_multiplex_active(False)
    yield
    _ss().set_multiplex_active(False)


def _make_profile(root, tag, config_yaml):
    home = root / f"profile-{tag}"
    home.mkdir(parents=True)
    (home / ".env").write_text(
        f"TELEGRAM_BOT_TOKEN=111:bot-{tag}\n"
        f"ANTHROPIC_API_KEY=key-{tag}\n"
        f"DATABASE_URL=postgresql://u:pw@127.0.0.1:5432/db-{tag}\n"
        f"SUPABASE_SERVICE_ROLE_KEY=srk-{tag}\n"
    )
    (home / "config.yaml").write_text(config_yaml)
    return home


_DATASTORE_CONFIG = (
    "datastore:\n"
    "  supabase_app:\n"
    "    dsn: ${DATABASE_URL}\n"
    "    service_role_key: ${SUPABASE_SERVICE_ROLE_KEY}\n"
)

_TELEGRAM_CONFIG = (
    "platforms:\n"
    "  telegram:\n"
    "    enabled: true\n"
    "    token: ${TELEGRAM_BOT_TOKEN}\n"
)


class TestConfigEnvRefExpansion:
    """``${VAR}`` in a profile's config.yaml resolves against that profile."""

    def _load_datastore(self, home):
        from hermes_cli.config import load_config

        with profile_runtime_scope(home):
            cfg = load_config()
        return (cfg.get("datastore") or {}).get("supabase_app") or {}

    def test_each_profile_expands_its_own_secrets(self, tmp_path, monkeypatch):
        monkeypatch.setenv("DATABASE_URL", "postgresql://u:pw@127.0.0.1:5432/db-process")
        monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "srk-process")
        _ss().set_multiplex_active(True)

        a = _make_profile(tmp_path, "a", _DATASTORE_CONFIG)
        b = _make_profile(tmp_path, "b", _DATASTORE_CONFIG)

        app_a = self._load_datastore(a)
        app_b = self._load_datastore(b)

        assert app_a["dsn"].endswith("/db-a")
        assert app_b["dsn"].endswith("/db-b")
        # The GoTrue keys are box-wide (FG-28 D2): one auth server per box.
        assert app_a["service_role_key"] == app_b["service_role_key"] == "srk-process"

    def test_cache_is_keyed_on_the_scope_not_only_the_file(self, tmp_path, monkeypatch):
        """An unscoped load of a profile's config must not poison its turn.

        ``load_config`` caches the *expanded* result per config path, so without
        the scope in the cache key an unscoped read (``hermes status`` listing
        every profile) would leave the process-env expansion in the cache and
        the profile's next turn would be served those values.
        """
        monkeypatch.setenv("DATABASE_URL", "postgresql://u:pw@127.0.0.1:5432/db-process")
        monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "srk-process")
        _ss().set_multiplex_active(True)

        a = _make_profile(tmp_path, "a", _DATASTORE_CONFIG)

        from hermes_cli.config import load_config
        from hermes_constants import set_hermes_home_override, reset_hermes_home_override

        token = set_hermes_home_override(str(a))
        try:
            unscoped = load_config()
        finally:
            reset_hermes_home_override(token)
        assert (unscoped["datastore"]["supabase_app"]["dsn"]).endswith("/db-process")

        assert self._load_datastore(a)["dsn"].endswith("/db-a")

    def test_unscoped_expansion_still_reads_environ(self, tmp_path, monkeypatch):
        """Single-profile behaviour is unchanged: no scope, no new failure."""
        monkeypatch.setenv("DATABASE_URL", "postgresql://u:pw@127.0.0.1:5432/db-process")
        monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "srk-process")
        a = _make_profile(tmp_path, "a", _DATASTORE_CONFIG)

        from hermes_cli.config import load_config
        from hermes_constants import set_hermes_home_override, reset_hermes_home_override

        token = set_hermes_home_override(str(a))
        try:
            cfg = load_config()
        finally:
            reset_hermes_home_override(token)
        assert cfg["datastore"]["supabase_app"]["dsn"].endswith("/db-process")

    def test_unset_reference_keeps_its_placeholder(self, tmp_path, monkeypatch):
        monkeypatch.delenv("DATABASE_URL", raising=False)
        _ss().set_multiplex_active(True)
        a = _make_profile(tmp_path, "a", "datastore:\n  supabase_app:\n    dsn: ${NOT_SET_ANYWHERE}\n")
        assert self._load_datastore(a)["dsn"] == "${NOT_SET_ANYWHERE}"


class TestGatewayPlatformTokens:
    """A profile's adapter is built with that profile's bot token."""

    def _telegram_token(self, home):
        from gateway.config import Platform, load_gateway_config

        with profile_runtime_scope(home):
            cfg = load_gateway_config()
            platform = cfg.platforms.get(Platform.TELEGRAM)
            return getattr(platform, "token", None)

    def test_env_override_does_not_win_over_the_profile(self, tmp_path, monkeypatch):
        monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "999:bot-process")
        _ss().set_multiplex_active(True)

        a = _make_profile(tmp_path, "a", _TELEGRAM_CONFIG)
        b = _make_profile(tmp_path, "b", _TELEGRAM_CONFIG)

        assert self._telegram_token(a) == "111:bot-a"
        assert self._telegram_token(b) == "111:bot-b"

    def test_env_override_still_applies_without_a_scope(self, tmp_path, monkeypatch):
        """The override is the documented single-profile behaviour; keep it."""
        monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "999:bot-process")
        a = _make_profile(tmp_path, "a", _TELEGRAM_CONFIG)

        from gateway.config import Platform, load_gateway_config
        from hermes_constants import set_hermes_home_override, reset_hermes_home_override

        token = set_hermes_home_override(str(a))
        try:
            cfg = load_gateway_config()
        finally:
            reset_hermes_home_override(token)
        assert cfg.platforms[Platform.TELEGRAM].token == "999:bot-process"


class TestAnthropicTokenResolution:
    """The provider fallback path reads the scope, not the process env."""

    def test_resolve_reads_the_active_profile(self, tmp_path, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "key-process")
        monkeypatch.delenv("ANTHROPIC_TOKEN", raising=False)
        monkeypatch.delenv("CLAUDE_CODE_OAUTH_TOKEN", raising=False)
        _ss().set_multiplex_active(True)

        from agent.anthropic_adapter import resolve_anthropic_token

        tok = _ss().set_secret_scope({"ANTHROPIC_API_KEY": "key-a"})
        try:
            assert resolve_anthropic_token() == "key-a"
        finally:
            _ss().reset_secret_scope(tok)

    def test_resolve_fails_closed_unscoped(self, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "key-process")
        monkeypatch.delenv("ANTHROPIC_TOKEN", raising=False)
        monkeypatch.delenv("CLAUDE_CODE_OAUTH_TOKEN", raising=False)
        _ss().set_multiplex_active(True)

        from agent.anthropic_adapter import resolve_anthropic_token

        with pytest.raises(_ss().UnscopedSecretError):
            resolve_anthropic_token()


class TestDotenvNeverReachesTheProcessEnvironment:
    """Nothing may write a profile's .env into os.environ while multiplexing."""

    def test_load_hermes_dotenv_is_refused(self, tmp_path, monkeypatch):
        from hermes_cli.env_loader import load_hermes_dotenv

        a = _make_profile(tmp_path, "a", _DATASTORE_CONFIG)
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        _ss().set_multiplex_active(True)

        assert load_hermes_dotenv(hermes_home=str(a)) == []
        assert "ANTHROPIC_API_KEY" not in os.environ

    def test_load_hermes_dotenv_still_loads_single_profile(self, tmp_path, monkeypatch):
        from hermes_cli.env_loader import load_hermes_dotenv

        a = _make_profile(tmp_path, "a", _DATASTORE_CONFIG)
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

        loaded = load_hermes_dotenv(hermes_home=str(a))
        assert loaded == [a / ".env"]
        assert os.environ["ANTHROPIC_API_KEY"] == "key-a"


class TestSubprocessInheritance:
    """A child spawned in profile A's turn must not carry another profile's keys.

    A contextvar does not cross a process boundary, so every spawn surface builds
    the child's environment from ``os.environ`` — which in a multiplexer is the
    *default* profile's ``.env``, loaded at import time by ``gateway/run.py``
    before any turn exists. These drive the real env builders every spawn goes
    through, then actually run a child with what they produced.
    """

    def _child_env_value(self, env, name):
        out = subprocess.run(
            [sys.executable, "-c", f"import os;print(os.environ.get({name!r}))"],
            capture_output=True,
            text=True,
            check=True,
            env=env,
        ).stdout.strip()
        return None if out == "None" else out

    def test_terminal_child_gets_the_running_profile_key(self, tmp_path, monkeypatch):
        """The terminal spawn path, with the key allowed through as passthrough."""
        from tools.environments.local import _make_run_env

        monkeypatch.setenv("ANTHROPIC_API_KEY", "key-process")
        monkeypatch.setattr(
            "tools.env_passthrough.is_env_passthrough",
            lambda key: key == "ANTHROPIC_API_KEY",
        )
        _ss().note_env_file_keys(["ANTHROPIC_API_KEY"])
        _ss().set_multiplex_active(True)
        a = _make_profile(tmp_path, "a", _DATASTORE_CONFIG)

        with profile_runtime_scope(a):
            run_env = _make_run_env({})

        assert self._child_env_value(run_env, "ANTHROPIC_API_KEY") == "key-a"

    def test_model_cli_child_gets_the_running_profile_key(self, tmp_path, monkeypatch):
        """``inherit_credentials=True`` — the blessed claude/codex executor."""
        from tools.environments.local import hermes_subprocess_env

        monkeypatch.setenv("ANTHROPIC_API_KEY", "key-process")
        _ss().note_env_file_keys(["ANTHROPIC_API_KEY"])
        _ss().set_multiplex_active(True)
        a = _make_profile(tmp_path, "a", _DATASTORE_CONFIG)
        b = _make_profile(tmp_path, "b", _DATASTORE_CONFIG)

        with profile_runtime_scope(a):
            env_a = hermes_subprocess_env(inherit_credentials=True)
        with profile_runtime_scope(b):
            env_b = hermes_subprocess_env(inherit_credentials=True)

        assert self._child_env_value(env_a, "ANTHROPIC_API_KEY") == "key-a"
        assert self._child_env_value(env_b, "ANTHROPIC_API_KEY") == "key-b"

    def test_a_key_the_profile_lacks_is_dropped_not_inherited(self, tmp_path, monkeypatch):
        """Fail closed: the child finds nothing rather than another profile's key."""
        from tools.environments.local import hermes_subprocess_env

        monkeypatch.setenv("DEEPSEEK_API_KEY", "deepseek-process")
        _ss().note_env_file_keys(["DEEPSEEK_API_KEY"])
        _ss().set_multiplex_active(True)
        a = _make_profile(tmp_path, "a", _DATASTORE_CONFIG)

        with profile_runtime_scope(a):
            env = hermes_subprocess_env(inherit_credentials=True)

        assert "DEEPSEEK_API_KEY" not in env

    def test_a_stripped_key_is_not_re_admitted_by_the_scope(self, tmp_path, monkeypatch):
        """The scope corrects *whose* credential a child sees, never *whether*."""
        from tools.environments.local import hermes_subprocess_env

        monkeypatch.setenv("ANTHROPIC_API_KEY", "key-process")
        monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "9999:bot-process")
        _ss().set_multiplex_active(True)
        a = _make_profile(tmp_path, "a", _DATASTORE_CONFIG)

        with profile_runtime_scope(a):
            env = hermes_subprocess_env()

        # Tier 2 (provider keys, no inherit_credentials) and Tier 1 (bot tokens).
        assert "ANTHROPIC_API_KEY" not in env
        assert "TELEGRAM_BOT_TOKEN" not in env

    def test_operator_exported_settings_survive(self, tmp_path, monkeypatch):
        """A value the operator exported is deployment-level, not profile-owned."""
        from tools.environments.local import hermes_subprocess_env

        monkeypatch.setenv("SOME_OPERATOR_SETTING", "from-the-unit-file")
        _ss().set_multiplex_active(True)
        a = _make_profile(tmp_path, "a", _DATASTORE_CONFIG)

        with profile_runtime_scope(a):
            env = hermes_subprocess_env()

        assert env["SOME_OPERATOR_SETTING"] == "from-the-unit-file"

    def test_single_profile_child_is_unchanged(self, tmp_path, monkeypatch):
        """No scope, no multiplexing: exactly the pre-FG-28 environment."""
        from tools.environments.local import hermes_subprocess_env

        monkeypatch.setenv("ANTHROPIC_API_KEY", "key-process")
        _ss().note_env_file_keys(["ANTHROPIC_API_KEY"])

        env = hermes_subprocess_env(inherit_credentials=True)

        assert self._child_env_value(env, "ANTHROPIC_API_KEY") == "key-process"


class TestEnvFileProvenance:
    """``load_hermes_dotenv`` must record which names it wrote to ``os.environ``.

    Without that record a profile-owned value and an operator-exported one are
    indistinguishable strings, and the spawn surfaces cannot tell which of the
    two they are allowed to correct.
    """

    def test_loading_records_the_keys(self, tmp_path, monkeypatch):
        from hermes_cli.env_loader import load_hermes_dotenv

        a = _make_profile(tmp_path, "a", _DATASTORE_CONFIG)
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

        load_hermes_dotenv(hermes_home=str(a))

        assert {"ANTHROPIC_API_KEY", "DATABASE_URL"} <= _ss().env_file_keys()
