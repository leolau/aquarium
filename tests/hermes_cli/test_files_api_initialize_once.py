"""``POST /api/registry/files/register`` runs the registry DDL once per process.

``FileRegistry.initialize`` drops and recreates RLS policies on its own
connection; running it on every upload made a 100-file burst exhaust the
connection pool. Concurrent first calls must still run it only once.
"""

import asyncio
from types import SimpleNamespace

from hermes_cli import files_api


class _Registry:
    def __init__(self, schema: str, calls: list[str]) -> None:
        self._store = SimpleNamespace(dsn="postgresql://x", schema=schema)
        self.role_reads = False
        self._calls = calls

    async def initialize(self) -> None:
        await asyncio.sleep(0.01)
        self._calls.append(self._store.schema)


def test_initialize_runs_once_per_registry_even_when_concurrent(monkeypatch):
    monkeypatch.setattr(files_api, "_INITIALIZED_REGISTRIES", set())
    calls: list[str] = []

    async def burst() -> None:
        await asyncio.gather(
            *(files_api._initialize_once(_Registry("app_prod", calls)) for _ in range(20))
        )
        await files_api._initialize_once(_Registry("app_dev", calls))

    asyncio.run(burst())
    assert calls == ["app_prod", "app_dev"]


def test_a_failed_initialize_is_retried(monkeypatch):
    monkeypatch.setattr(files_api, "_INITIALIZED_REGISTRIES", set())
    calls: list[str] = []

    class _Flaky(_Registry):
        async def initialize(self) -> None:
            calls.append("try")
            if len(calls) == 1:
                raise RuntimeError("pool full")

    async def run() -> None:
        try:
            await files_api._initialize_once(_Flaky("app_prod", calls))
        except RuntimeError:
            pass
        await files_api._initialize_once(_Flaky("app_prod", calls))
        await files_api._initialize_once(_Flaky("app_prod", calls))

    asyncio.run(run())
    assert calls == ["try", "try"]
