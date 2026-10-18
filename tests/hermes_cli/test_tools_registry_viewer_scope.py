"""``GET /api/tools`` (and its read siblings) list what the *logged-in person*
may see: a member gets their own private entries plus shared ones; the owner and
callers with no login (operator token / internal service) get every entry.

The handlers are called directly with a real Starlette ``Request`` carrying the
dashboard-auth ``session`` the login gate would attach. The principal store and
registry are in-memory fakes; the registry filters with the real C2 rule
(``hermes_cli.access.can_read``), so the test pins *who* the read is scoped to.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

pytest.importorskip("fastapi")

from starlette.requests import Request  # noqa: E402

from hermes_cli import access, datastore, tools_registry, web_server  # noqa: E402
from hermes_cli.access import Principal, can_read  # noqa: E402

OWNER = Principal(user_id="leo_owner", display="Leo", role="owner")
MEMBER = Principal(user_id="mia_member", display="Mia", role="member")
OTHER = Principal(user_id="olly_member", display="Olly", role="member")


def _tool(name: str, owner: Principal, visibility: str) -> tools_registry.Tool:
    return tools_registry.Tool(
        id=f"id-{name}",
        name=name,
        kind="in_house",
        stack="python",
        owner_user_id=owner.user_id,
        visibility=visibility,
        mode="prod",
        status="enabled",
        mcp_endpoint_ref=None,
        web_url=None,
        config_json={},
    )


ROWS = [
    _tool("shared_app", OWNER, "shared"),
    _tool("leo_private", OWNER, OWNER.private_visibility),
    _tool("mia_private", MEMBER, MEMBER.private_visibility),
    _tool("olly_private", OTHER, OTHER.private_visibility),
]


class _FakePrincipalStore:
    def __init__(self, _store) -> None:
        self._by_id = {p.user_id: p for p in (OWNER, MEMBER, OTHER)}

    async def resolve_alias(self, subject: str):
        return None

    async def get(self, user_id: str):
        return self._by_id.get(user_id)

    async def get_owner(self):
        return OWNER


class _FakeRegistry:
    def __init__(self, _store) -> None:
        pass

    async def initialize(self) -> None:
        return None

    async def list_for_principal(self, principal):
        return [t for t in ROWS if can_read(principal, t.visibility)]


@pytest.fixture(autouse=True)
def _fakes(monkeypatch):
    monkeypatch.setattr(web_server, "_comms_app_store", lambda: object())
    monkeypatch.setattr(access, "PrincipalStore", _FakePrincipalStore)
    monkeypatch.setattr(datastore, "get_store", lambda *a, **k: object())
    monkeypatch.setattr(tools_registry, "ToolRegistry", _FakeRegistry)


def _request(subject: str | None = None) -> Request:
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/api/tools",
        "headers": [],
        "query_string": b"",
        "state": {},
    }
    if subject is not None:
        scope["state"]["session"] = SimpleNamespace(user_id=subject)
    return Request(scope)


def _names(subject: str | None) -> set[str]:
    body = asyncio.run(web_server.list_tools(_request(subject), mode="prod"))
    assert body["configured"] is True
    return {t["name"] for t in body["tools"]}


def test_member_sees_own_and_shared_only():
    assert _names(MEMBER.user_id) == {"shared_app", "mia_private"}


def test_owner_login_sees_everything():
    assert _names(OWNER.user_id) == {r.name for r in ROWS}


def test_no_login_operator_caller_keeps_owner_view():
    assert _names(None) == {r.name for r in ROWS}


def test_unknown_login_is_rejected_not_upgraded_to_owner():
    with pytest.raises(web_server.HTTPException) as exc:
        asyncio.run(web_server.list_tools(_request("stranger"), mode="prod"))
    assert exc.value.status_code == 409


def test_health_hides_other_peoples_private_tools_from_member():
    with pytest.raises(web_server.HTTPException) as exc:
        asyncio.run(
            web_server.tool_health(_request(MEMBER.user_id), "olly_private", mode="prod")
        )
    assert exc.value.status_code == 404
    own = asyncio.run(
        web_server.tool_health(_request(MEMBER.user_id), "mia_private", mode="prod")
    )
    assert own["name"] == "mia_private"


def test_unconfigured_datastore_degrades_gracefully(monkeypatch):
    def _boom():
        raise RuntimeError("no DSN")

    monkeypatch.setattr(web_server, "_comms_app_store", _boom)
    body = asyncio.run(web_server.list_tools(_request(MEMBER.user_id), mode="prod"))
    assert body["configured"] is False
    assert body["tools"] == []
