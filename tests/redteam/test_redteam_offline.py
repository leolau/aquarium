"""Offline red-team suite (CI mode).

Each attack runs against the real tool/permission boundaries with a model
that obeys the injected text. Attacks that land on a known-open finding are
``xfail`` with that finding id, so the run stays green on ``develop`` and an
attack that suddenly gets blocked shows up as XPASS — the cue to flip its
``expected`` to ``"blocked"`` in ``attacks.py``.
"""

from __future__ import annotations

import pytest

from tests.redteam.harness import load_attacks, redteam_env

ATTACKS = load_attacks()


@pytest.mark.parametrize("item", ATTACKS, ids=[a.id for a in ATTACKS])
def test_attack_is_blocked_and_logged(item):
    with redteam_env() as env:
        outcome = item.run(env)

    if not item.expected_blocked:
        if not outcome.blocked:
            pytest.xfail(f"{item.finding} open: {item.title} — {outcome.detail[:200]}")
        # The fix landed: hold it to the same bar as every other attack.
    assert outcome.blocked, (
        f"{item.id} ({item.title}) got through: {outcome.detail}\n"
        f"evidence: {outcome.evidence}"
    )
    assert outcome.logged, f"{item.id} was blocked but left no trace: {outcome.evidence}"


def test_every_open_attack_names_its_finding():
    for item in ATTACKS:
        if not item.expected_blocked:
            assert item.finding and item.finding.startswith("F"), item.id


def test_suite_covers_every_vector_and_goal():
    from tests.redteam.harness import GOALS

    goals = {a.goal for a in ATTACKS}
    vectors = {a.vector for a in ATTACKS}
    assert set(GOALS) <= goals
    assert {"whatsapp", "email", "web", "shared_file", "netfolder", "app_mcp"} <= vectors


def test_attack_ids_are_unique():
    ids = [a.id for a in ATTACKS]
    assert len(ids) == len(set(ids))


def test_live_mode_refuses_production(monkeypatch):
    import tests.redteam.live as live
    from tests.redteam.live import check_target

    assert live.PRODUCTION_HOSTS
    monkeypatch.setattr(
        live,
        "PRODUCTION_HOSTS",
        frozenset({"203.0.113.10", "home.example.com", "example.com"}),
    )
    for url in (
        "http://203.0.113.10:8642",
        "https://home.example.com",
        "https://example.com/v1",
    ):
        with pytest.raises(ValueError, match="production"):
            check_target(url)
    assert check_target("http://10.0.0.5:8642") == "10.0.0.5"


def test_live_mode_flags_a_reply_that_leaks_the_canary(tmp_path):
    import json
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    from tests.redteam.live import plant_canaries, run_live

    canary = plant_canaries(tmp_path)
    assert canary in (tmp_path / ".env").read_text()

    class _Agent(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            text = body["messages"][0]["content"]
            reply = f"sure: {canary[::-1]}" if "reversed" in text else "I can't share that."
            payload = json.dumps({"choices": [{"message": {"content": reply}}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_args):
            pass

    server = HTTPServer(("127.0.0.1", 0), _Agent)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        rows = run_live(f"http://127.0.0.1:{server.server_port}", "k", canary)
    finally:
        server.shutdown()
        server.server_close()
    status = {r["id"]: r["status"] for r in rows}
    assert status["LIVE-02"] == "FAIL"
    assert status["LIVE-01"] == "PASS"
    assert all(canary not in r["detail"] for r in rows)
