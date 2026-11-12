"""Arrivals from box-wide accounts are filed as the person who connected them.

FG-38 P2a: a calendar connected in Settings, a WhatsApp bridge added in
Settings and a shared mailbox whose credential someone saved file their items
(and attachments) as that person. With no known person they stay the install
owner's, exactly as before.
"""

import sys
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "custom"))

from tests.custom.test_calendar_poller_delta import (  # noqa: E402,F401
    add_account,
    api_capture,
    db,
    make_event,
    poller,
)
from tests.custom.test_wa_batcher_timestamp import (  # noqa: E402,F401
    _bridge_message,
    batcher,
)


def _capture_registry(monkeypatch):
    registered = []
    registry = types.SimpleNamespace(
        register_item=lambda **kw: registered.append(kw) or "item-1"
    )
    monkeypatch.setitem(sys.modules, "shared.inbound_registration", registry)
    return registered


# -- WhatsApp ---------------------------------------------------------------


def test_whatsapp_message_filed_as_bridge_person(batcher, monkeypatch):  # noqa: F811
    module, _ = batcher
    registered = _capture_registry(monkeypatch)
    module.process_message(
        _bridge_message("wa-1", "85212345678", 1790766223), "phone1",
        owner_user_id="mia",
    )
    assert [kw["owner_user_id"] for kw in registered] == ["mia"]


def test_whatsapp_message_without_person_stays_owner(batcher, monkeypatch):  # noqa: F811
    module, _ = batcher
    registered = _capture_registry(monkeypatch)
    module.process_message(_bridge_message("wa-2", "85212345678", 1790766223), "phone1")
    assert [kw["owner_user_id"] for kw in registered] == [None]


def test_running_batcher_picks_up_a_reassignment(batcher, monkeypatch):  # noqa: F811
    """Whose a phone's messages are is looked up per batch, not once at start:
    a change in Settings › Accounts reaches the long-running poll loop."""
    module, _ = batcher
    owners = iter(["leo", "sam"])
    monkeypatch.setattr(module, "phone_owner", lambda phone: next(owners))
    seen = []
    monkeypatch.setattr(
        module, "process_message",
        lambda msg, phone, bridge_port=None, owner_user_id=None: seen.append(owner_user_id),
    )

    class _Stop(BaseException):
        pass

    batches = iter([b'[{"messageId": "a"}]', b'[{"messageId": "b"}]'])

    class _Resp:
        def read(self):
            try:
                return next(batches)
            except StopIteration:
                raise _Stop

    monkeypatch.setattr(module, "urlopen", lambda url, timeout=None: _Resp())
    monkeypatch.setattr(module.time, "sleep", lambda _s: None)
    with pytest.raises(_Stop):
        module.poll_bridge({"bridge_port": 3000, "id": "phone1"})
    assert seen == ["leo", "sam"]


def test_phone_owner_from_bridge_added_in_settings(batcher, tmp_path, monkeypatch):  # noqa: F811
    module, _ = batcher
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    from hermes_cli import wa_bridge_owners

    wa_bridge_owners.record_owner("mia-phone", "mia", port=3002)
    assert module.phone_owner({"id": "phone3", "bridge_port": 3002}) == "mia"
    assert module.phone_owner({"id": "phone1", "bridge_port": 3000}) is None
    assert module.phone_owner(
        {"id": "phone3", "bridge_port": 3002, "owner_user_id": "sam"}
    ) == "sam"


def test_whatsapp_media_filed_as_bridge_person(batcher, monkeypatch):  # noqa: F811
    module, db_path = batcher
    files = []
    fake = types.SimpleNamespace(register_file=lambda data, **kw: files.append(kw) or True)
    monkeypatch.setitem(sys.modules, "shared.file_registration", fake)
    import sqlite3

    conn = sqlite3.connect(db_path)
    module._save_and_register_media(
        b"jpeg", "a.jpg", "image/jpeg", "wa-3", str(db_path.parent / "a.jpg"),
        conn, "phone1", "chat", "852", "Ada", None, "item-1", "mia",
    )
    assert files[0]["owner_user_id"] == "mia"


# -- Calendar ---------------------------------------------------------------


def _creds(poller_mod, owner):  # noqa: F811
    return poller_mod.google_oauth.GoogleCredentials("id", "secret", "rt", owner, "mia@x.com")


def test_calendar_event_filed_as_connecting_person(poller, db, monkeypatch):  # noqa: F811
    add_account(db)
    api_capture([make_event()], monkeypatch, poller)
    poller.sync_events(db, "gcal1", _creds(poller, "mia"))
    assert [r["owner_user_id"] for r in poller._test_registrations] == ["mia"]


def test_calendar_event_update_keeps_its_person(poller, db, monkeypatch):  # noqa: F811
    """A reassignment is for new events: the poller asks the registry to keep an
    already-registered event with its person rather than copy it to the new one."""
    add_account(db)
    api_capture([make_event()], monkeypatch, poller)
    poller.sync_events(db, "gcal1", _creds(poller, "mia"))
    assert [r.get("keep_owner") for r in poller._test_registrations] == [True]


def test_legacy_calendar_without_person_stays_owner(poller, db, monkeypatch):  # noqa: F811
    add_account(db)
    api_capture([make_event()], monkeypatch, poller)
    poller.sync_events(db, "gcal1", _creds(poller, ""))
    assert [r["owner_user_id"] for r in poller._test_registrations] == [None]


# -- Shared mailbox ---------------------------------------------------------


@pytest.fixture
def email_poller(monkeypatch):
    sys.path.insert(0, str(ROOT / "custom" / "email"))
    import email_poller as mod

    return mod


def test_shared_mailbox_owner(email_poller):
    cred = types.SimpleNamespace(owner_user_id="mia")
    assert email_poller.account_owner({"id": "email1"}, cred) == "mia"
    assert email_poller.account_owner({"id": "email1", "owner_user_id": "sam"}, cred) == "sam"
    assert email_poller.account_owner({"id": "email1"}, types.SimpleNamespace(owner_user_id="")) is None
    assert email_poller.account_owner({"id": "email1"}, None) is None


def test_password_mailbox_cred_is_the_saving_person(email_poller, monkeypatch):
    mia = types.SimpleNamespace(name="info@x.com", owner_user_id="mia", payload={"p": 1})
    bob = types.SimpleNamespace(name="info@x.com", owner_user_id="bob", payload={"p": 2})
    monkeypatch.setattr(email_poller, "load_personal_mailboxes", lambda: [mia, bob])
    assert email_poller._mailbox_cred({"address": "INFO@x.com"}) is mia
    assert email_poller._mailbox_cred({"address": "info@x.com", "owner_user_id": "bob"}) is bob
    assert email_poller._mailbox_payload({"address": "info@x.com", "owner_user_id": "bob"}) == {"p": 2}
    assert email_poller._mailbox_cred({"address": "other@x.com"}) is None


# -- File registration ------------------------------------------------------


def test_register_file_as_person_never_falls_back_to_owner(monkeypatch):
    import hermes_cli.file_registry as file_registry
    import shared.file_registration as fr
    import shared.inbound_registration as ir

    stored = []

    async def store_and_register(principal, data, **kw):
        stored.append(principal)
        return object()

    async def resolve_person(user_id):
        return {"mia": "MIA"}.get(user_id)

    async def owner():
        return "OWNER"

    monkeypatch.setattr(file_registry, "store_and_register", store_and_register)
    monkeypatch.setattr(ir, "resolve_person", resolve_person)
    monkeypatch.setattr(fr, "_resolve_owner", owner)
    assert fr.register_file(b"x", surface="whatsapp", filename="a", owner_user_id="mia")
    assert not fr.register_file(b"x", surface="whatsapp", filename="a", owner_user_id="gone")
    assert fr.register_file(b"x", surface="whatsapp", filename="a")
    assert stored == ["MIA", "OWNER"]


# -- Triage to-dos ----------------------------------------------------------


def test_a_todo_for_a_person_s_arrival_is_that_person_s(monkeypatch):
    import hermes_cli.inbound_registry as inbound_registry
    import hermes_cli.todo_notifier as todo_notifier
    import shared.inbound_registration as ir
    import shared.todo_registration as tr

    owner, mia = types.SimpleNamespace(user_id="leo"), types.SimpleNamespace(user_id="mia")
    owners = {"M1": ["mia"], "M2": ["gone"], "M3": [], "M4": RuntimeError("no table")}
    created = []

    class Registry:
        async def owners_for(self, principal, *, surface, external_id, account_id):
            if isinstance(owners[external_id], Exception):
                raise owners[external_id]
            return owners[external_id]

        async def id_for(self, principal, **kw):
            return f"item-{principal.user_id}"

    class Store:
        async def create(self, principal, **kw):
            created.append((principal.user_id, kw["source_ref"]))
            return types.SimpleNamespace(id="t", stage=kw["stage"], created=True, notified_at=None, title="x")

    async def resolve_owner():
        return owner

    async def resolve_person(user_id):
        return {"mia": mia}.get(user_id)

    monkeypatch.setattr(tr, "resolve_owner", resolve_owner)
    monkeypatch.setattr(ir, "resolve_person", resolve_person)
    monkeypatch.setattr(inbound_registry, "default_registry", lambda mode: Registry())
    monkeypatch.setattr(todo_notifier, "default_stores", lambda: (Store(), None))

    for ext in ("M1", "M2", "M3", "M4"):
        tr.register_todo(title="Reply", surface="whatsapp", account_id="phone3", external_id=ext)
    # M2's person is gone: no to-do. M3 never registered, and M4 has no registry
    # to ask: the owner files them, as before.
    assert created == [("mia", "item-mia"), ("leo", "item-leo"), ("leo", "item-leo")]
