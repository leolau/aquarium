"""End-to-end: an async auxiliary vision call through the real resolver,
the real AsyncOpenAI SDK and a real (local) HTTP provider lands in
``api_call_log`` with its latency, tokens and cost — and the Models ▸
Performance endpoint reports them.

Regression for the Models page showing "avg 0ms · 0 in · 0 out · $0" for
aux models: AsyncOpenAI's ``create`` is not a coroutine *function*, so the
ledger shim logged when the coroutine object was created instead of when
the request finished.
"""
import asyncio
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

_REGISTRY = {
    "opencode-go": {
        "id": "opencode-go",
        "name": "OpenCode Go",
        "api": "https://opencode.ai/zen/go/v1",
        "models": {
            "qwen3.8-max": {
                "id": "qwen3.8-max",
                "modalities": {"input": ["text", "image"], "output": ["text"]},
                "cost": {"input": 2, "output": 6, "cache_read": 0.25},
                "limit": {"context": 262144, "output": 32768},
            },
            "no-price-model": {"id": "no-price-model"},
        },
    }
}


class _Provider(BaseHTTPRequestHandler):
    delay = 0.15

    def do_POST(self):  # noqa: N802 — http.server API
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        time.sleep(self.delay)
        payload = {
            "id": "chatcmpl-1",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": body["model"],
            "choices": [{
                "index": 0,
                "finish_reason": "stop",
                "message": {"role": "assistant", "content": "a red square"},
            }],
            "usage": {
                "prompt_tokens": 1500,
                "completion_tokens": 200,
                "total_tokens": 1700,
                "prompt_tokens_details": {"cached_tokens": 500},
            },
        }
        raw = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *args):
        pass


@pytest.fixture(autouse=True)
def _isolate_caches():
    """The aux client cache and models.dev cache are process-global; leave
    them empty so later tests don't inherit this test's provider."""
    import agent.auxiliary_client as aux
    import agent.models_dev as md
    import hermes_state

    yield
    aux._client_cache.clear()
    md._models_dev_cache = {}
    md._models_dev_cache_time = 0
    hermes_state._METRICS_DBS.clear()


@pytest.fixture
def provider():
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Provider)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}/v1"
    server.shutdown()


def _setup_home(monkeypatch, base_url, model):
    import hermes_state
    from hermes_constants import get_hermes_home

    home = get_hermes_home()
    home.mkdir(parents=True, exist_ok=True)
    (home / "config.yaml").write_text(
        "auxiliary:\n"
        "  vision:\n"
        "    provider: opencode-go\n"
        f"    model: {model}\n"
    )
    # Fresh disk cache → the real models.dev loader serves it, no network.
    (home / "models_dev_cache.json").write_text(json.dumps(_REGISTRY))
    monkeypatch.setenv("OPENCODE_GO_API_KEY", "test-key")
    monkeypatch.setenv("OPENCODE_GO_BASE_URL", base_url)
    monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", home / "state.db")
    hermes_state._METRICS_DBS.clear()

    import agent.auxiliary_client as aux
    import agent.models_dev as md

    md._models_dev_cache = {}
    md._models_dev_cache_time = 0
    aux._client_cache.clear()
    return home


def _vision_call():
    from agent.auxiliary_client import async_call_llm

    return asyncio.run(async_call_llm(
        task="vision",
        messages=[{"role": "user", "content": [
            {"type": "text", "text": "What is in this image?"},
            {"type": "image_url", "image_url": {
                "url": "data:image/png;base64,iVBORw0KGgo="}},
        ]}],
        max_tokens=50,
    ))


def _ledger_rows():
    from hermes_state import api_metrics_db

    return api_metrics_db()._conn.execute(
        "SELECT * FROM api_call_log ORDER BY id").fetchall()


def _performance():
    from starlette.testclient import TestClient

    from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN, app

    client = TestClient(app)
    client.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    resp = client.get("/api/analytics/models/performance?days=7")
    assert resp.status_code == 200
    return {m["model"]: m for m in resp.json()["models"]}


def test_async_vision_call_records_latency_tokens_and_cost(monkeypatch, provider):
    _setup_home(monkeypatch, provider, "qwen3.8-max")

    resp = _vision_call()
    assert resp.choices[0].message.content == "a red square"

    rows = _ledger_rows()
    assert len(rows) == 1
    row = rows[0]
    assert row["caller"] == "aux:vision"
    assert row["provider"] == "opencode-go"
    assert row["model"] == "qwen3.8-max"
    assert row["duration_ms"] >= 100  # the provider took 150ms
    assert row["input_tokens"] == 1000  # prompt minus cached, as main rows
    assert row["cache_read_tokens"] == 500
    assert row["output_tokens"] == 200
    # 1000×$2/M + 500×$0.25/M + 200×$6/M
    assert row["cost_usd"] == pytest.approx(0.003325)
    assert row["cost_status"] == "estimated"

    card = _performance()["qwen3.8-max"]
    assert card["caller_roles"] == ["vision"]
    assert card["latency_ms"]["avg"] >= 100
    assert card["tokens"]["input"] == 1000 and card["tokens"]["output"] == 200
    assert card["cost_usd"] == pytest.approx(0.003325)
    assert card["cost_status"] == "known"


def test_unpriced_model_reports_unknown_cost_not_zero(monkeypatch, provider):
    _setup_home(monkeypatch, provider, "no-price-model")

    _vision_call()

    row = _ledger_rows()[0]
    assert row["output_tokens"] == 200 and row["duration_ms"] >= 100
    assert row["cost_usd"] is None and row["cost_status"] == "unknown"

    card = _performance()["no-price-model"]
    assert card["cost_usd"] is None
    assert card["cost_status"] == "unknown"
    assert card["unpriced_calls"] == 1
