"""``cron.model`` in config.yaml: one model for every scheduled job that pins
neither a provider nor a model.

Drives the real ``run_job`` path (mocked AIAgent + resolve_runtime_provider)
against a temp HERMES_HOME, and ``create_job`` snapshot capture.
"""

import contextlib
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from cron.scheduler import run_job

MAIN = "model:\n  provider: opencode-go\n  default: main-model\n"
CRON = "cron:\n  model:\n    provider: deepseek\n    default: cron-model\n"


def _job(**overrides):
    job = {
        "id": "cron-model-test",
        "name": "cron model test",
        "prompt": "hello",
        "model": None,
        "provider": None,
        "provider_snapshot": None,
        "model_snapshot": None,
        "base_url": None,
    }
    job.update(overrides)
    return job


def _run(job, config_yaml, tmp_path, resolved_provider="deepseek"):
    """Return (success, error, agent model or None, requested provider)."""
    (tmp_path / "config.yaml").write_text(config_yaml)
    resolver = MagicMock(
        return_value={
            "api_key": "test-key",
            "base_url": "https://example.invalid/v1",
            "provider": resolved_provider,
            "api_mode": "chat_completions",
        }
    )
    with patch("cron.scheduler._hermes_home", tmp_path), \
         patch("cron.scheduler._get_hermes_home", return_value=tmp_path), \
         patch("cron.scheduler._resolve_origin", return_value=None), \
         patch("hermes_cli.env_loader.load_hermes_dotenv"), \
         patch("hermes_cli.env_loader.reset_secret_source_cache"), \
         patch("hermes_state.SessionDB", return_value=MagicMock()), \
         patch("hermes_cli.runtime_provider.resolve_runtime_provider", resolver), \
         patch("run_agent.AIAgent") as agent_cls:
        agent_cls.return_value.run_conversation.return_value = {"final_response": "ok"}
        success, _output, _final, error = run_job(job)
    model = agent_cls.call_args.kwargs.get("model") if agent_cls.called else None
    requested = resolver.call_args.kwargs.get("requested") if resolver.called else None
    return success, error, model, requested


def test_unpinned_job_uses_cron_model(tmp_path, monkeypatch):
    monkeypatch.delenv("HERMES_MODEL", raising=False)
    success, error, model, requested = _run(_job(), MAIN + CRON, tmp_path)
    assert success, error
    assert model == "cron-model"
    assert requested == "deepseek"


def test_cron_model_wins_over_hermes_model_env(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_MODEL", "env-model")
    _success, _error, model, _requested = _run(_job(), MAIN + CRON, tmp_path)
    assert model == "cron-model"


def test_empty_cron_model_follows_main_model(tmp_path, monkeypatch):
    monkeypatch.delenv("HERMES_MODEL", raising=False)
    empty = "cron:\n  model:\n    provider: ''\n    default: ''\n"
    success, error, model, requested = _run(
        _job(), MAIN + empty, tmp_path, resolved_provider="opencode-go"
    )
    assert success, error
    assert model == "main-model"
    assert requested is None


def test_pinned_job_ignores_cron_model(tmp_path):
    job = _job(provider="opencode-go", model="pinned-model")
    success, error, model, requested = _run(
        job, MAIN + CRON, tmp_path, resolved_provider="opencode-go"
    )
    assert success, error
    assert model == "pinned-model"
    assert requested == "opencode-go"


def test_model_only_pin_keeps_main_provider(tmp_path):
    success, error, model, requested = _run(
        _job(model="pinned-model"), MAIN + CRON, tmp_path,
        resolved_provider="opencode-go",
    )
    assert success, error
    assert model == "pinned-model"
    assert requested is None


def test_changing_cron_model_is_not_blocked_by_drift_guard(tmp_path, monkeypatch):
    """A job created while it followed main-model keeps running after the
    operator sets cron.model: that switch is explicit, not silent drift."""
    monkeypatch.delenv("HERMES_MODEL", raising=False)
    job = _job(provider_snapshot="opencode-go", model_snapshot="main-model")
    success, error, model, _requested = _run(job, MAIN + CRON, tmp_path)
    assert success, error
    assert model == "cron-model"


def test_drift_guard_still_applies_without_cron_model(tmp_path, monkeypatch):
    monkeypatch.delenv("HERMES_MODEL", raising=False)
    job = _job(provider_snapshot="opencode-go", model_snapshot="old-model")
    success, _error, model, _requested = _run(
        job, MAIN, tmp_path, resolved_provider="opencode-go"
    )
    assert not success
    assert model is None


def _isolate_storage(monkeypatch, tmp_path, config_yaml):
    import cron.jobs as jobs

    @contextlib.contextmanager
    def _noop_lock():
        yield

    (tmp_path / "config.yaml").write_text(config_yaml)
    monkeypatch.setattr(jobs, "_jobs_lock", _noop_lock, raising=True)
    monkeypatch.setattr(jobs, "load_jobs", lambda: [], raising=True)
    monkeypatch.setattr(jobs, "save_jobs", lambda j: None, raising=True)
    monkeypatch.setattr(jobs, "get_hermes_home", lambda: tmp_path, raising=True)
    return jobs


def test_create_job_following_cron_model_has_no_snapshots(monkeypatch, tmp_path):
    jobs = _isolate_storage(monkeypatch, tmp_path, MAIN + CRON)
    with patch(
        "hermes_cli.runtime_provider.resolve_runtime_provider",
        return_value={"provider": "deepseek"},
    ):
        job = jobs.create_job(prompt="report", schedule="every 1 hour")
    assert job["provider_snapshot"] is None
    assert job["model_snapshot"] is None


def test_create_job_without_cron_model_still_snapshots(monkeypatch, tmp_path):
    jobs = _isolate_storage(monkeypatch, tmp_path, MAIN)
    with patch(
        "hermes_cli.runtime_provider.resolve_runtime_provider",
        return_value={"provider": "opencode-go"},
    ):
        job = jobs.create_job(prompt="report", schedule="every 1 hour")
    assert job["provider_snapshot"] == "opencode-go"
    assert job["model_snapshot"] == "main-model"
