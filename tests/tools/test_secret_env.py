"""FG-37 W2: secrets by name — list_secrets and terminal secret_env (real local shell)."""

from __future__ import annotations

import asyncio
import base64
import json

import pytest

import hermes_cli.credential_store as cs
import tools.secret_list_tool  # noqa: F401  (registers list_secrets)
import tools.terminal_tool as terminal_tool
from agent.redact import redact_sensitive_text, runtime_secrets
from hermes_cli.access import Principal
from tools.access_policy import acting_as
from tools.environments.local import LocalEnvironment

ALICE = Principal(user_id="alice", display="Alice", role="member")
BOB = Principal(user_id="bob", display="Bob", role="member")
PAT = "alice-fake-token-123456"
BOB_PAT = "bob-only-token-987"
TASK = "secret-env-test"


@pytest.fixture
def store(tmp_path, monkeypatch):
    store = cs.FileCredentialStore(root=tmp_path / "credentials")
    asyncio.run(store.initialize())

    async def seed():
        await store.put(ALICE, provider="secret", name="github-pat", kind="secret",
                        payload={"value": PAT, "username": "alice-gh"})
        await store.put(ALICE, provider="secret", name="erp-login", kind="password",
                        payload={"username": "alice", "password": "erp-pass-42"})
        await store.put(BOB, provider="secret", name="bob-pat", kind="secret",
                        payload={"value": BOB_PAT})

    asyncio.run(seed())
    monkeypatch.setattr(cs, "default_credential_store", lambda *a, **k: store)
    return store


@pytest.fixture
def shell(tmp_path, monkeypatch):
    env = LocalEnvironment(cwd=str(tmp_path), timeout=30)
    monkeypatch.setattr(terminal_tool, "_active_environments", {TASK: env})
    monkeypatch.setattr(terminal_tool, "_last_activity", {})
    monkeypatch.setattr(terminal_tool, "_task_env_overrides", {})
    monkeypatch.setattr(terminal_tool, "_start_cleanup_thread", lambda: None)
    monkeypatch.setattr(terminal_tool, "_get_env_config", lambda: {
        "env_type": "local", "cwd": str(tmp_path), "timeout": 30, "lifetime_seconds": 3600,
    })
    monkeypatch.setattr(terminal_tool, "_check_all_guards",
                        lambda *a, **k: {"approved": True})
    yield env
    env.cleanup()


def run(command, user="alice", **kw):
    with acting_as(user, "member"):
        return json.loads(terminal_tool.terminal_tool(command=command, task_id=TASK, **kw))


def test_value_is_injected_and_masked_in_output(store, shell):
    out = run('[ "$TOKEN" = "%s" ] && echo match; echo "raw:$TOKEN"; '
              'printf %%s "$TOKEN" | base64' % PAT,
              secret_env={"TOKEN": "github-pat"})
    assert out["exit_code"] == 0
    assert "match" in out["output"]
    assert "raw:***" in out["output"]
    assert PAT not in json.dumps(out)
    assert base64.b64encode(PAT.encode()).decode() not in json.dumps(out)


def test_fields_username_and_password(store, shell):
    out = run('[ "$U" = alice ] && [ "$P" = erp-pass-42 ] && [ "$G" = alice-gh ] && echo ok',
              secret_env={"U": "erp-login.username", "P": "erp-login.password",
                          "G": "github-pat.username"})
    assert out["output"].strip() == "ok"


def test_value_is_for_one_command_only(store, shell):
    run("export TOKEN; true", secret_env={"TOKEN": "github-pat"})
    out = run('echo "[${TOKEN-}]"; env | grep -c HERMES_SECRET_ENV_ || true')
    assert out["output"].split() == ["[]", "0"]
    snapshot = shell._snapshot_path
    with open(snapshot, encoding="utf-8") as fh:
        assert PAT not in fh.read()


def test_other_users_secret_is_not_usable(store, shell):
    out = run('echo "$T"', secret_env={"T": "bob-pat"})
    assert out["exit_code"] == -1
    assert "'bob-pat'" in out["error"]
    assert BOB_PAT not in json.dumps(out)
    assert run('echo "$T"', user="bob", secret_env={"T": "bob-pat"})["output"] == "***"


def test_owner_cannot_use_a_members_secret(store, shell):
    with acting_as("owner-1", "owner"):
        out = json.loads(terminal_tool.terminal_tool(
            command='echo "$T"', task_id=TASK, secret_env={"T": "github-pat"}))
    assert out["exit_code"] == -1 and PAT not in json.dumps(out)


def test_unknown_name_names_the_secret(store, shell):
    out = run("true", secret_env={"T": "nope"})
    assert out["exit_code"] == -1
    assert "'nope'" in out["error"]


@pytest.mark.parametrize("env_name", ["PATH", "LD_PRELOAD", "HERMES_SECRET_ENV_0", "1BAD"])
def test_reserved_or_invalid_variable_rejected(store, shell, env_name):
    out = run("true", secret_env={env_name: "github-pat"})
    assert out["exit_code"] == -1 and PAT not in json.dumps(out)


def test_background_is_refused(store, shell):
    out = run("sleep 1", secret_env={"T": "github-pat"}, background=True)
    assert out["exit_code"] == -1 and "foreground" in out["error"]


def test_unsupported_backend_is_refused(store, monkeypatch):
    class RemoteEnv:
        env = {}

        def execute(self, command, **kwargs):  # pragma: no cover - must not run
            raise AssertionError("ran")

    monkeypatch.setattr(terminal_tool, "_active_environments", {TASK: RemoteEnv()})
    monkeypatch.setattr(terminal_tool, "_last_activity", {})
    monkeypatch.setattr(terminal_tool, "_task_env_overrides", {})
    monkeypatch.setattr(terminal_tool, "_get_env_config", lambda: {
        "env_type": "ssh", "cwd": "/", "timeout": 30, "lifetime_seconds": 3600,
    })
    monkeypatch.setattr(terminal_tool, "_check_all_guards", lambda *a, **k: {"approved": True})
    out = run("true", secret_env={"T": "github-pat"})
    assert out["exit_code"] == -1 and "not supported" in out["error"]


def test_list_secrets_has_names_but_no_values(store):
    from tools.registry import registry

    with acting_as("alice", "member"):
        raw = registry.dispatch("list_secrets", {})
    data = json.loads(raw)
    assert [s["name"] for s in data["secrets"]] == ["erp-login", "github-pat"]
    assert {s["kind"] for s in data["secrets"]} == {"secret", "password"}
    assert data["secrets"][1]["username"] == "alice-gh"
    assert all(s["updated_at"] for s in data["secrets"])
    for leaked in (PAT, "erp-pass-42", BOB_PAT, "bob-pat"):
        assert leaked not in raw
    assert all(set(s) <= {"name", "kind", "username", "updated_at"} for s in data["secrets"])


def test_list_secrets_registered_in_core_toolsets():
    from toolsets import _HERMES_CORE_TOOLS, resolve_toolset

    assert "list_secrets" in _HERMES_CORE_TOOLS
    assert "list_secrets" in resolve_toolset("hermes-api-server")
    assert "secret_env" in terminal_tool.TERMINAL_SCHEMA["parameters"]["properties"]


def test_runtime_secrets_mask_text_even_when_redaction_off(monkeypatch):
    import agent.redact as redact

    monkeypatch.setattr(redact, "_REDACT_ENABLED", False)
    with runtime_secrets(["opaque-value-1"]):
        assert redact_sensitive_text("x opaque-value-1 y") == "x *** y"
    assert redact_sensitive_text("x opaque-value-1 y") == "x opaque-value-1 y"


def test_secret_kind_matches_contract():
    spec = cs.CREDENTIAL_KINDS["secret"]
    assert (spec.required, spec.optional, spec.secret_fields) == (
        ("value",), ("username", "note"), ("value",))
