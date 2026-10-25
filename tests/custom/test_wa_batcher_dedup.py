"""A message the bridge re-delivers is stored and mirrored once.

``INSERT OR IGNORE`` never raises on a duplicate id, so the batcher has to
check the rowcount; otherwise every re-delivery re-registers the message in
the shared inbound registry (a Postgres upsert per copy).
"""

import sys
import types

from tests.custom.test_wa_batcher_timestamp import (  # noqa: F401
    _bridge_message,
    _stored,
    batcher,
)


def test_redelivered_message_registers_once(batcher, monkeypatch):  # noqa: F811
    module, db_path = batcher
    registered = []
    registry = types.SimpleNamespace(
        register_item=lambda **kw: registered.append(kw["external_id"])
    )
    monkeypatch.setitem(sys.modules, "shared.inbound_registration", registry)

    msg = _bridge_message("wa-1", "85212345678", 1790766223)
    module.process_message(msg, "85200000000")
    module.process_message(msg, "85200000000")

    assert list(_stored(db_path)) == ["wa-1"]
    assert registered == ["wa-1"]


def test_distinct_messages_each_register(batcher, monkeypatch):  # noqa: F811
    module, _ = batcher
    registered = []
    registry = types.SimpleNamespace(
        register_item=lambda **kw: registered.append(kw["external_id"])
    )
    monkeypatch.setitem(sys.modules, "shared.inbound_registration", registry)

    for i in range(3):
        module.process_message(
            _bridge_message(f"wa-{i}", "85212345678", 1790766223 + i),
            "85200000000",
        )

    assert registered == ["wa-0", "wa-1", "wa-2"]
