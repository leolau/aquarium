"""Seminar survey: trigger matching, answer validation, copy, and the worker."""

from __future__ import annotations

import asyncio
import dataclasses
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from hermes_cli import web_server
from hermes_cli.invitations import RedeemThrottle
from hermes_cli.seminar_outreach import BridgeSendError, run_once, send_whatsapp
from hermes_cli.seminar_survey import (
    Job,
    SurveyError,
    SurveySettings,
    SurveyState,
    completion_message,
    invite_message,
    is_survey_request,
    survey_link,
    survey_request_messages,
    validate_answers,
)

SETTINGS = SurveySettings()
QR_TEXT = "I want to do the survey and get the presentation link."


class TestTrigger:
    @pytest.mark.parametrize(
        "text",
        [
            QR_TEXT,
            "i want to do the survey and get the presentation link",
            "Hi!  I want to do the survey, and get the presentation link 🙏",
            "我想填寫問卷並索取講座簡報。",
            f"{QR_TEXT} 我想填寫問卷並索取講座簡報。",
        ],
    )
    def test_prefilled_text_matches(self, text: str) -> None:
        assert is_survey_request(text, SETTINGS.trigger_phrases)

    @pytest.mark.parametrize(
        "text",
        [
            "",
            "survey",
            "I want to do the survey",
            "Can I get the presentation link?",
            "I want to do the surveys and get the presentation links",
        ],
    )
    def test_other_text_does_not_match(self, text: str) -> None:
        assert not is_survey_request(text, SETTINGS.trigger_phrases)

    def _batch(self, **message: object) -> dict[str, object]:
        base: dict[str, object] = {
            "msg_id": "m1",
            "text": QR_TEXT,
            "chat_id": "239908434235494@lid",
            "is_group": 0,
            "sender_name": "Parent",
        }
        base.update(message)
        return {"source_phone": "phone2", "messages": [base]}

    def test_batch_request_on_seminar_number_is_found(self) -> None:
        batch = self._batch()
        assert survey_request_messages(batch, SETTINGS) == batch["messages"]

    def test_group_messages_and_other_numbers_are_ignored(self) -> None:
        assert survey_request_messages(self._batch(is_group=1), SETTINGS) == []
        other = self._batch()
        other["source_phone"] = "phone1"
        assert survey_request_messages(other, SETTINGS) == []

    def test_configured_phrases_replace_the_defaults(self) -> None:
        settings = SurveySettings.from_config(
            {"seminar_survey": {"trigger_phrases": ["Slides please"]}}
        )
        assert settings.trigger_phrases == ("Slides please",)
        assert is_survey_request("slides please!", settings.trigger_phrases)
        assert not is_survey_request(QR_TEXT, settings.trigger_phrases)


VALID = {
    "rating": 5,
    "grades": ["P4", "P1"],
    "comment": "  Very practical  ",
    "share": "anonymous",
    "next_step": "workshop",
    "name": "Chan Tai Man",
    "stay_in_touch": True,
}


class TestAnswers:
    def test_valid_answers_are_normalised(self) -> None:
        assert validate_answers(VALID) == {
            "rating": 5,
            "grades": ["P1", "P4"],
            "comment": "Very practical",
            "share": "anonymous",
            "next_step": "workshop",
            "name": "Chan Tai Man",
            "stay_in_touch": True,
        }

    @pytest.mark.parametrize(
        "change",
        [
            {"rating": 0},
            {"rating": 6},
            {"rating": True},
            {"rating": "5"},
            {"grades": []},
            {"grades": ["P7"]},
            {"share": "sure"},
            {"next_step": "anything"},
            {"name": "   "},
        ],
    )
    def test_invalid_answers_are_refused_bilingually(
        self, change: dict[str, object]
    ) -> None:
        with pytest.raises(SurveyError) as err:
            validate_answers({**VALID, **change})
        message = str(err.value)
        assert any("\u4e00" <= ch <= "\u9fff" for ch in message)
        assert any(ch.isascii() and ch.isalpha() for ch in message)

    def test_optional_fields_default(self) -> None:
        answers = validate_answers(
            {k: v for k, v in VALID.items() if k not in {"comment", "stay_in_touch"}}
        )
        assert answers["comment"] == ""
        assert answers["stay_in_touch"] is False


class TestCopy:
    def test_invite_carries_the_link_in_both_languages(self) -> None:
        settings = dataclasses.replace(SETTINGS, public_base_url="https://home.example.com")
        link = survey_link(settings, "tok")
        assert link == "https://home.example.com/survey/tok"
        text = invite_message(link)
        assert text.count(link) == 2
        assert "問卷" in text and "survey" in text

    def test_completion_carries_the_slides_and_thanks(self) -> None:
        text = completion_message(SETTINGS.presentation_url)
        assert text.count("https://canva.link/puysezdoxbb5sk6") == 2
        assert "多謝您出席講座並完成問卷" in text
        assert "Thank you for attending the seminar and completing the survey" in text


class FakeStore:
    def __init__(self, job: Job | None) -> None:
        self.settings = SETTINGS
        self._job = job
        self.sent: list[tuple[Job, str]] = []
        self.failed: list[tuple[Job, str]] = []

    async def claim(self) -> Job | None:
        job, self._job = self._job, None
        return job

    async def mark_sent(self, job: Job, message_id: str) -> None:
        self.sent.append((job, message_id))

    async def mark_failed(self, job: Job, error: str) -> None:
        self.failed.append((job, error))


def _bridge(status: int, payload: object, seen: list[dict[str, object]]):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/send"
        seen.append(json.loads(request.content))
        return httpx.Response(status, json=payload)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


class TestWorker:
    def _run(self, store: FakeStore, client: httpx.AsyncClient) -> bool:
        async def go() -> bool:
            async with client:
                return await run_once(store, client)

        return asyncio.run(go())

    def test_idle_queue_sends_nothing(self) -> None:
        seen: list[dict[str, object]] = []
        assert self._run(FakeStore(None), _bridge(200, {}, seen)) is False
        assert seen == []

    def test_invite_goes_to_the_requesting_chat(self) -> None:
        job = Job("invite", "id-1", "239908434235494@lid", "tok123")
        store = FakeStore(job)
        seen: list[dict[str, object]] = []
        assert self._run(store, _bridge(200, {"success": True, "messageId": "W1"}, seen))
        assert seen[0]["chatId"] == "239908434235494@lid"
        assert "/survey/tok123" in str(seen[0]["message"])
        assert store.sent == [(job, "W1")]

    def test_completion_sends_the_slides(self) -> None:
        job = Job("complete", "id-1", "239908434235494@lid")
        store = FakeStore(job)
        seen: list[dict[str, object]] = []
        self._run(store, _bridge(200, {"messageId": "W2"}, seen))
        assert SETTINGS.presentation_url in str(seen[0]["message"])
        assert store.sent == [(job, "W2")]

    @pytest.mark.parametrize(
        ("status", "payload"),
        [(503, {"error": "Not connected"}), (200, {"success": True})],
    )
    def test_bridge_refusal_releases_the_job(
        self, status: int, payload: object
    ) -> None:
        job = Job("invite", "id-1", "x@lid", "tok")
        store = FakeStore(job)
        self._run(store, _bridge(status, payload, []))
        assert store.sent == []
        assert [j for j, _ in store.failed] == [job]

    def test_unreachable_bridge_is_a_send_error(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("refused", request=request)

        async def go() -> None:
            async with httpx.AsyncClient(
                transport=httpx.MockTransport(handler)
            ) as client:
                await send_whatsapp(client, "http://127.0.0.1:3001", "x@lid", "hi")

        with pytest.raises(BridgeSendError):
            asyncio.run(go())


class FakeStateStore:
    settings = SETTINGS

    async def survey_state(self, token: str) -> SurveyState:
        return SurveyState(status="invited", submitted=False)


class SlowStateStore:
    """Counts how many lookups hit the database at once."""

    def __init__(self, concurrency: int) -> None:
        self.settings = SurveySettings(db_concurrency=concurrency)
        self.in_flight = 0
        self.peak = 0

    async def survey_state(self, token: str) -> SurveyState:
        self.in_flight += 1
        self.peak = max(self.peak, self.in_flight)
        try:
            await asyncio.sleep(0.01)
            return SurveyState(status="invited", submitted=False)
        finally:
            self.in_flight -= 1


class BrokenStore:
    settings = SETTINGS

    async def survey_state(self, token: str) -> SurveyState:
        raise ConnectionError("max clients reached")


class TestPublicThrottle:
    @pytest.fixture
    def client(self, monkeypatch: pytest.MonkeyPatch) -> TestClient:
        monkeypatch.setattr(web_server, "_SEMINAR_STORE", FakeStateStore())
        monkeypatch.setattr(web_server, "_SEMINAR_THROTTLE", None)
        monkeypatch.setattr(web_server, "_SEMINAR_DB_SLOTS", None)
        monkeypatch.setattr(web_server.app.state, "auth_required", False, raising=False)
        return TestClient(web_server.app)

    def test_a_whole_audience_on_one_address_gets_through(
        self, client: TestClient
    ) -> None:
        for n in range(150):
            response = client.post(
                "/api/seminar/survey/state", json={"token": f"attendee-{n}"}
            )
            assert response.status_code == 200, n

    def test_hammering_one_link_is_told_to_wait(self, client: TestClient) -> None:
        codes = [
            client.post("/api/seminar/survey/state", json={"token": "one"}).status_code
            for _ in range(21)
        ]
        assert codes[:20] == [200] * 20
        limited = client.post("/api/seminar/survey/submit", json={"token": "one"})
        assert limited.status_code == 429
        assert "稍候" in limited.json()["detail"]

    def test_ip_allowance_defaults_to_the_token_allowance(self) -> None:
        throttle = RedeemThrottle(max_attempts=2)
        assert [throttle.allow(ip="1.1.1.1", token=f"t{n}") for n in range(3)] == [
            True,
            True,
            False,
        ]


class TestPublicBurst:
    @pytest.fixture(autouse=True)
    def _app(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(web_server, "_SEMINAR_THROTTLE", None)
        monkeypatch.setattr(web_server, "_SEMINAR_DB_SLOTS", None)
        monkeypatch.setattr(web_server.app.state, "auth_required", False, raising=False)

    def test_a_burst_queues_for_the_database_instead_of_failing(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        store = SlowStateStore(concurrency=3)
        monkeypatch.setattr(web_server, "_SEMINAR_STORE", store)

        async def burst() -> list[int]:
            transport = httpx.ASGITransport(app=web_server.app)
            async with httpx.AsyncClient(
                transport=transport, base_url="http://test"
            ) as client:
                responses = await asyncio.gather(
                    *[
                        client.post(
                            "/api/seminar/survey/state", json={"token": f"t{n}"}
                        )
                        for n in range(30)
                    ]
                )
            return [r.status_code for r in responses]

        assert asyncio.run(burst()) == [200] * 30
        assert store.peak == 3

    def test_database_trouble_is_a_bilingual_503(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(web_server, "_SEMINAR_STORE", BrokenStore())
        response = TestClient(web_server.app).post(
            "/api/seminar/survey/state", json={"token": "t"}
        )
        assert response.status_code == 503
        assert "問卷暫時無法使用" in response.json()["detail"]
