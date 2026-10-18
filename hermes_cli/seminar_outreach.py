"""Seminar outreach worker: drains the ``seminar_survey_signups`` queue.

For each claimed request it sends, through the seminar WhatsApp number's bridge
(``seminar_survey.bridge_url`` in ``config.yaml``) into the requester's chat:

* ``invite``   — the personal survey link ``/survey/<token>``;
* ``complete`` — the presentation slides and the thank-you, once the survey
  behind that link has been submitted.

Runs as ``python -m hermes_cli.seminar_outreach``
(deploy/hermes-seminar-outreach.service).
See hermes_cli/seminar_survey.py for the queue semantics.
"""

from __future__ import annotations

import asyncio
import logging
import signal
from typing import Protocol

import httpx

from hermes_cli.seminar_survey import (
    Job,
    SurveySettings,
    completion_message,
    default_store,
    invite_message,
    survey_link,
)

logger = logging.getLogger("seminar_outreach")

SEND_TIMEOUT_SECONDS = 60.0


class OutreachQueue(Protocol):
    """The slice of :class:`~hermes_cli.seminar_survey.SurveyStore` used here."""

    @property
    def settings(self) -> SurveySettings: ...

    async def claim(self) -> Job | None: ...

    async def mark_sent(self, job: Job, message_id: str) -> None: ...

    async def mark_failed(self, job: Job, error: str) -> None: ...


class BridgeSendError(RuntimeError):
    """The WhatsApp bridge did not accept the message."""


async def send_whatsapp(
    client: httpx.AsyncClient, bridge_url: str, chat_id: str, message: str
) -> str:
    """POST to the bridge's ``/send``; return the WhatsApp message id."""
    try:
        response = await client.post(
            f"{bridge_url}/send",
            json={"chatId": chat_id, "message": message},
            timeout=SEND_TIMEOUT_SECONDS,
        )
    except httpx.HTTPError as exc:
        raise BridgeSendError(f"bridge unreachable: {exc}") from exc
    if response.status_code != 200:
        raise BridgeSendError(
            f"bridge answered {response.status_code}: {response.text[:200]}"
        )
    payload = response.json()
    message_id = payload.get("messageId") if isinstance(payload, dict) else None
    if not message_id:
        raise BridgeSendError(f"bridge returned no message id: {payload!r}")
    return str(message_id)


def render(store: OutreachQueue, job: Job) -> str:
    settings = store.settings
    if job.kind == "invite":
        if not job.token:
            raise ValueError("an invite job must carry its survey token")
        return invite_message(survey_link(settings, job.token))
    return completion_message(settings.presentation_url)


async def run_once(store: OutreachQueue, client: httpx.AsyncClient) -> bool:
    """Process one due job. Returns ``False`` when the queue is empty."""
    job = await store.claim()
    if job is None:
        return False
    try:
        message_id = await send_whatsapp(
            client,
            store.settings.bridge_url,
            job.chat_id,
            render(store, job),
        )
    except BridgeSendError as exc:
        logger.warning("%s for signup %s failed: %s", job.kind, job.signup_id, exc)
        await store.mark_failed(job, str(exc))
        return True
    await store.mark_sent(job, message_id)
    logger.info("%s sent for signup %s", job.kind, job.signup_id)
    return True


async def run_forever(store: OutreachQueue, stop: asyncio.Event) -> None:
    settings = store.settings
    async with httpx.AsyncClient() as client:
        while not stop.is_set():
            try:
                worked = await run_once(store, client)
            except Exception:  # noqa: BLE001 — a DB blip must not kill the unit
                logger.exception("outreach iteration failed")
                worked = False
            delay = settings.send_interval_seconds if worked else settings.poll_seconds
            try:
                await asyncio.wait_for(stop.wait(), timeout=delay)
            except asyncio.TimeoutError:
                pass


def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s"
    )
    store = default_store()
    stop = asyncio.Event()

    async def _run() -> None:
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, stop.set)  # windows-footgun: ok — Linux-server-only code
        await store.initialize()
        logger.info(
            "seminar outreach worker started (campaign=%s, bridge=%s)",
            store.settings.campaign,
            store.settings.bridge_url,
        )
        await run_forever(store, stop)

    asyncio.run(_run())


if __name__ == "__main__":
    main()
