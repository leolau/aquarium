"""A transient datastore failure is a retryable 503 — never a 500, never a
fallback identity — and a non-UUID to-do id never reaches Postgres."""

from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException

asyncpg = pytest.importorskip("asyncpg")

from hermes_cli import web_server  # noqa: E402
from hermes_cli.access import Principal, PrincipalStore  # noqa: E402
from hermes_cli.todo_store import TodoStore  # noqa: E402


class _Request:
    def __init__(self) -> None:
        self.query_params: dict = {}
        self.headers: dict = {}

        class _State:
            session = None

        self.state = _State()


@pytest.mark.parametrize(
    "error",
    [
        asyncpg.exceptions.InternalServerError(
            "(EMAXCONNSESSION) max clients reached in session mode"
        ),
        asyncpg.exceptions.ConnectionDoesNotExistError("connection was closed"),
        ConnectionResetError("reset by peer"),
        asyncio.TimeoutError(),
    ],
)
def test_principal_lookup_datastore_failure_is_a_503(monkeypatch, error) -> None:
    async def _boom(self, **kwargs):
        raise error

    monkeypatch.setattr(web_server, "_comms_app_store", lambda: object())
    monkeypatch.setattr(PrincipalStore, "get_owner", _boom)
    with pytest.raises(HTTPException) as caught:
        asyncio.run(web_server._comms_resolve_principal(_Request()))
    assert caught.value.status_code == 503


def test_principal_lookup_programming_errors_still_surface(monkeypatch) -> None:
    async def _boom(self, **kwargs):
        raise KeyError("bug")

    monkeypatch.setattr(web_server, "_comms_app_store", lambda: object())
    monkeypatch.setattr(PrincipalStore, "get_owner", _boom)
    with pytest.raises(KeyError):
        asyncio.run(web_server._comms_resolve_principal(_Request()))


class _NoConnectStore:
    mode = "prod"
    schema = "app_prod"
    dsn = "postgresql://unused"

    async def connect(self):  # pragma: no cover - must never be reached
        raise AssertionError("a non-UUID id must not reach Postgres")


@pytest.mark.parametrize("todo_id", ["not-a-uuid", "tsk_1", "", "1; DROP TABLE tasks"])
def test_a_non_uuid_todo_id_is_simply_absent(todo_id: str) -> None:
    store = TodoStore(_NoConnectStore())  # type: ignore[arg-type]
    principal = Principal(user_id="ada", display="Ada", role="member")  # type: ignore[arg-type]
    assert asyncio.run(store.get(principal, todo_id)) is None
    assert asyncio.run(store.history(principal, todo_id)) == []
