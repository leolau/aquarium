"""The WhatsApp batcher paces its bridge polling.

``GET /messages`` on the bridge drains its queue and answers immediately (~1ms
with an empty queue), so a poll loop that only sleeps on the error path spins at
the bridge's response rate — hundreds of requests a second, per bridge, forever.
On the systest box that pinned ``batcher.py`` at 92% CPU for a day and pushed
both bridge processes to ~50% each. These tests run the real ``poll_bridge``
loop against a stubbed bridge.
"""

import importlib.util
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
BATCHER = REPO_ROOT / "custom" / "whatsapp" / "batcher.py"


class _StopLoop(BaseException):
    """Breaks out of ``while True``; not an ``Exception`` so the loop's own
    ``except Exception`` handler doesn't swallow it."""


def _load(tmp_path, batching=None):
    """Exec batcher.py with its hard-coded deployment root pointed at tmp_path."""
    root = tmp_path / "whatsapp-messages"
    root.mkdir()
    (root / "config.json").write_text(
        json.dumps({"phones": [], "batching": batching or {}})
    )
    source = BATCHER.read_text().replace("/opt/data/whatsapp-messages", str(root))
    spec = importlib.util.spec_from_loader("_test_wa_batcher", loader=None)
    module = importlib.util.module_from_spec(spec)
    module.__file__ = str(BATCHER)
    sys.modules["_test_wa_batcher"] = module
    try:
        exec(compile(source, str(BATCHER), "exec"), module.__dict__)
    finally:
        del sys.modules["_test_wa_batcher"]
    return module


def _run_poll_loop(module, payload=b"[]", iterations=3):
    """Drive poll_bridge for N successful polls, returning the sleeps it made."""
    class _Resp:
        def read(self):
            return payload

    polls = []
    sleeps = []

    def fake_urlopen(url, timeout=None):
        polls.append(url)
        if len(polls) > iterations:
            raise _StopLoop
        return _Resp()

    def fake_sleep(seconds):
        sleeps.append(seconds)

    module.urlopen = fake_urlopen
    module.time.sleep = fake_sleep
    with pytest.raises(_StopLoop):
        module.poll_bridge({"bridge_port": 3000, "id": "phone1"})
    return polls, sleeps


def test_sleeps_between_successful_polls(tmp_path):
    module = _load(tmp_path)
    polls, sleeps = _run_poll_loop(module)

    assert len(polls) == 4  # 3 successful, 4th raises to end the loop
    assert sleeps == [1.0, 1.0, 1.0]


def test_poll_interval_is_configurable(tmp_path):
    module = _load(tmp_path, batching={"poll_interval_seconds": 0.25})
    _, sleeps = _run_poll_loop(module, iterations=2)

    assert sleeps == [0.25, 0.25]


def test_error_path_still_backs_off(tmp_path):
    from urllib.error import URLError

    module = _load(tmp_path)
    calls = []
    sleeps = []

    def fake_urlopen(url, timeout=None):
        calls.append(url)
        if len(calls) > 2:
            raise _StopLoop
        raise URLError("bridge down")

    module.urlopen = fake_urlopen
    module.time.sleep = sleeps.append
    with pytest.raises(_StopLoop):
        module.poll_bridge({"bridge_port": 3000, "id": "phone1"})

    assert sleeps == [2, 2]
