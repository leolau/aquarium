"""Drive ingestion orchestration: budget, resumption, and what it refuses.

The Drive client itself is exercised against a fake URL opener (real request
shapes, no network); the walk is exercised against a fake reader, because what
matters is the *policy* — newest-first, budget counted in documents, one bad file
never ending a run, and nothing ever ingested as ``shared``.
"""

from __future__ import annotations

import argparse
import json
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from hermes_cli.access import Principal
from hermes_cli.rag_cmd import register_rag_subparser, total_failure
from hermes_cli.rag_drive import (
    SOURCE_KIND,
    DriveError,
    DriveFile,
    GoogleDriveReader,
    accounts_to_ingest,
    credential_path,
    discover_accounts,
    ingest_drive,
)

PRINCIPAL = Principal(user_id="leo_owner", display="Leo", role="owner")

DOC = "application/vnd.google-apps.document"
SHEET = "application/vnd.google-apps.spreadsheet"


def _file(file_id: str, name: str, *, mime: str = DOC, modified: str = "") -> DriveFile:
    return DriveFile(
        id=file_id,
        name=name,
        mime_type=mime,
        modified_time=modified or "2026-04-01T10:00:00.000Z",
    )


class FakeReader:
    def __init__(self, files, texts, *, failing: set[str] | None = None) -> None:
        self._files = files
        self._texts = texts
        self._failing = failing or set()
        self.account = "leo@example.com"
        self.extracted: list[str] = []

    def list_files(self, *, page_size: int = 100):
        yield from self._files

    def extract_text(self, file: DriveFile) -> str:
        if file.id in self._failing:
            raise DriveError("export failed (500)")
        self.extracted.append(file.id)
        return self._texts.get(file.id, "")


class FakeRag:
    """Records ingest calls and replays a scripted outcome per source_ref."""

    def __init__(self, outcomes=None) -> None:
        self.calls: list[dict[str, object]] = []
        self.outcomes = outcomes or {}

    async def ingest(self, principal, **kwargs):
        self.calls.append({"principal": principal.user_id, **kwargs})
        from plugins.memory.supabase_pgvector.rag import IngestResult

        return self.outcomes.get(
            kwargs["source_ref"], IngestResult("doc-1", 3, False)
        )


@pytest.mark.asyncio
async def test_the_budget_counts_documents_not_files() -> None:
    """A folder of images must not consume the run's budget.

    ``--limit`` exists to bound *embedding* work, which images cost nothing of.
    Counting listed files instead would let a photo album stop the walk before it
    reached a single document.
    """
    files = [_file("img-1", "photo.jpg", mime="image/jpeg")] * 5 + [
        _file("doc-1", "Tender A"),
        _file("doc-2", "Tender B"),
    ]
    reader = FakeReader(files, {"doc-1": "text one", "doc-2": "text two"})
    rag = FakeRag()

    summary = await ingest_drive(rag, PRINCIPAL, reader, limit=2)

    assert summary.ingested == 2
    assert summary.skipped == 5
    assert [call["source_ref"] for call in rag.calls] == ["doc-1", "doc-2"]


@pytest.mark.asyncio
async def test_unchanged_documents_count_against_the_budget_but_cost_nothing(
) -> None:
    """Why a re-run resumes rather than restarting.

    An unchanged document consumes budget so a nightly run walks forward through
    the corpus instead of re-confirming the same newest 50 documents for ever.
    """
    from plugins.memory.supabase_pgvector.rag import IngestResult

    files = [_file("doc-1", "A"), _file("doc-2", "B"), _file("doc-3", "C")]
    reader = FakeReader(files, {"doc-1": "a", "doc-2": "b", "doc-3": "c"})
    rag = FakeRag(
        {
            "doc-1": IngestResult("d1", 0, True, "unchanged"),
            "doc-2": IngestResult("d2", 0, True, "unchanged"),
        }
    )

    summary = await ingest_drive(rag, PRINCIPAL, reader, limit=2)

    assert (summary.unchanged, summary.ingested) == (2, 0)
    assert "doc-3" not in [call["source_ref"] for call in rag.calls]


@pytest.mark.asyncio
async def test_one_unreadable_file_does_not_end_the_run() -> None:
    files = [_file("bad", "Locked"), _file("doc-1", "Tender A")]
    reader = FakeReader(files, {"doc-1": "text"}, failing={"bad"})
    rag = FakeRag()

    summary = await ingest_drive(rag, PRINCIPAL, reader, limit=10)

    assert summary.ingested == 1
    assert summary.failures and "Locked" in summary.failures[0]


@pytest.mark.asyncio
async def test_one_document_the_embedder_refuses_does_not_end_the_run() -> None:
    """The failure that actually happened: a chunk past the embedding
    service's per-text ceiling raised out of ``rag.ingest``, and every newer
    document behind it went un-ingested on every nightly pass."""
    files = [_file("doc-1", "Huge export"), _file("doc-2", "Tender B")]
    reader = FakeReader(files, {"doc-1": "text", "doc-2": "text"})

    class RefusingRag(FakeRag):
        async def ingest(self, principal, **kwargs):
            if kwargs["source_ref"] == "doc-1":
                raise RuntimeError("texts at [0] exceed 8192 chars")
            return await super().ingest(principal, **kwargs)

    rag = RefusingRag()
    summary = await ingest_drive(rag, PRINCIPAL, reader, limit=10)

    assert summary.ingested == 1
    assert [call["source_ref"] for call in rag.calls] == ["doc-2"]
    assert summary.failures and "8192" in summary.failures[0]


@pytest.mark.asyncio
async def test_ingestion_never_asks_for_shared_visibility() -> None:
    """A file shared *with* an account is not a file the instance may read.

    There is no visibility argument here on purpose, so the store's private
    default applies and a Drive document cannot be laundered instance-wide by an
    unattended job.
    """
    reader = FakeReader([_file("doc-1", "Contract")], {"doc-1": "text"})
    rag = FakeRag()

    await ingest_drive(rag, PRINCIPAL, reader, limit=1)

    assert "visibility" not in rag.calls[0]
    assert rag.calls[0]["source_kind"] == SOURCE_KIND
    assert rag.calls[0]["source_ref"] == "doc-1"


@pytest.mark.asyncio
async def test_an_empty_export_is_skipped_rather_than_stored() -> None:
    reader = FakeReader([_file("doc-1", "Empty")], {"doc-1": "   \n"})
    rag = FakeRag()

    summary = await ingest_drive(rag, PRINCIPAL, reader, limit=5)

    assert (summary.skipped, summary.ingested) == (1, 0)
    assert rag.calls == []


@pytest.mark.asyncio
async def test_the_drive_modification_time_travels_with_the_document() -> None:
    reader = FakeReader(
        [_file("doc-1", "A", modified="2026-03-02T08:30:00.000Z")],
        {"doc-1": "text"},
    )
    rag = FakeRag()

    await ingest_drive(rag, PRINCIPAL, reader, limit=1)

    stamp = rag.calls[0]["source_modified_at"]
    assert stamp is not None and stamp.year == 2026 and stamp.month == 3


# ---------------------------------------------------------------------------
# Accounts + credentials
# ---------------------------------------------------------------------------

def _write_credential(directory: Path, email: str, **overrides) -> Path:
    document = {
        "token": "at",
        "refresh_token": "rt",
        "client_id": "cid",
        "client_secret": "cs",
        "scopes": ["https://www.googleapis.com/auth/drive.readonly"],
    }
    document.update(overrides)
    path = credential_path(directory, email)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(document), "utf-8")
    return path


def test_accounts_come_from_the_credential_store_not_config(tmp_path: Path) -> None:
    _write_credential(tmp_path, "leolau@joyaether.com")
    _write_credential(tmp_path, "leo11lau@gmail.com")

    assert discover_accounts(tmp_path) == [
        "leo11lau@gmail.com",
        "leolau@joyaether.com",
    ]
    assert accounts_to_ingest(tmp_path, []) == [
        "leo11lau@gmail.com",
        "leolau@joyaether.com",
    ]


def test_the_credential_stores_own_files_are_not_accounts(tmp_path: Path) -> None:
    """A pending consent leaves ``oauth_states.json`` beside the accounts."""
    _write_credential(tmp_path, "leolau@joyaether.com")
    (tmp_path / "oauth_states.json").write_text(
        json.dumps({"e8b1": {"session_id": "s"}}), "utf-8"
    )

    assert discover_accounts(tmp_path) == ["leolau@joyaether.com"]
    assert accounts_to_ingest(tmp_path, []) == ["leolau@joyaether.com"]


def test_an_account_with_no_credentials_is_an_error_not_a_no_op(
    tmp_path: Path,
) -> None:
    """"Nothing was ingested" and "that account is not connected" differ."""
    _write_credential(tmp_path, "leolau@joyaether.com")

    with pytest.raises(DriveError) as excinfo:
        accounts_to_ingest(tmp_path, ["nobody@example.com"])

    assert "nobody@example.com" in str(excinfo.value)
    assert "leolau@joyaether.com" in str(excinfo.value)


def test_a_credential_without_a_drive_scope_is_refused_before_any_request(
    tmp_path: Path,
) -> None:
    """Fail with the fix in the message, not with a 403 mid-walk."""
    path = _write_credential(
        tmp_path,
        "leolau@joyaether.com",
        scopes=["https://www.googleapis.com/auth/calendar"],
    )

    with pytest.raises(DriveError) as excinfo:
        GoogleDriveReader.from_file(path)

    assert "drive.readonly" in str(excinfo.value)


def test_a_truncated_credential_file_names_what_is_missing(tmp_path: Path) -> None:
    path = _write_credential(tmp_path, "leolau@joyaether.com", refresh_token="")

    with pytest.raises(DriveError) as excinfo:
        GoogleDriveReader.from_file(path)

    assert "refresh_token" in str(excinfo.value)


# ---------------------------------------------------------------------------
# The Drive client's request shapes
# ---------------------------------------------------------------------------

class FakeOpener:
    """Answers request URLs from a script, recording what was asked."""

    def __init__(self, responses: dict[str, bytes]) -> None:
        self.responses = responses
        self.requests: list[urllib.request.Request] = []

    def __call__(self, request: urllib.request.Request) -> bytes:
        self.requests.append(request)
        for fragment, body in self.responses.items():
            if fragment in request.full_url:
                return body
        raise AssertionError(f"unexpected request: {request.full_url}")


def _reader(opener: FakeOpener) -> GoogleDriveReader:
    return GoogleDriveReader(
        {
            "refresh_token": "rt",
            "client_id": "cid",
            "client_secret": "cs",
            "account": "leolau@joyaether.com",
        },
        opener=opener,
    )


def test_listing_asks_for_shared_drives_and_shared_with_me() -> None:
    """Without both all-drives flags Drive silently returns owned files only.

    "All of Drive" was an explicit decision, and this is the line that
    implements it — a default that looks like it works while quietly excluding
    every document somebody else shared.
    """
    opener = FakeOpener(
        {
            "oauth2": json.dumps({"access_token": "at"}).encode(),
            "drive/v3/files": json.dumps(
                {
                    "files": [
                        {
                            "id": "doc-1",
                            "name": "Tender",
                            "mimeType": DOC,
                            "modifiedTime": "2026-04-01T10:00:00.000Z",
                        }
                    ]
                }
            ).encode(),
        }
    )

    files = list(_reader(opener).list_files())

    assert [file.id for file in files] == ["doc-1"]
    listing = opener.requests[-1].full_url
    assert "includeItemsFromAllDrives=true" in listing
    assert "supportsAllDrives=true" in listing
    assert "corpora=allDrives" in listing
    assert "orderBy=modifiedTime+desc" in listing


def test_listing_follows_page_tokens() -> None:
    pages = [
        json.dumps(
            {"files": [{"id": "a", "name": "A", "mimeType": DOC}], "nextPageToken": "p2"}
        ).encode(),
        json.dumps({"files": [{"id": "b", "name": "B", "mimeType": DOC}]}).encode(),
    ]

    class Paging(FakeOpener):
        def __call__(self, request):
            self.requests.append(request)
            if "oauth2" in request.full_url:
                return json.dumps({"access_token": "at"}).encode()
            return pages.pop(0)

    files = list(_reader(Paging({})).list_files())

    assert [file.id for file in files] == ["a", "b"]


def test_a_google_doc_is_exported_as_text_and_a_sheet_as_csv() -> None:
    opener = FakeOpener(
        {
            "oauth2": json.dumps({"access_token": "at"}).encode(),
            "/export": "Bids close at 17:00.".encode(),
        }
    )
    reader = _reader(opener)

    text = reader.extract_text(_file("doc-1", "Tender"))

    assert text == "Bids close at 17:00."
    assert "mimeType=text%2Fplain" in opener.requests[-1].full_url

    reader.extract_text(_file("sheet-1", "Prices", mime=SHEET))
    assert "mimeType=text%2Fcsv" in opener.requests[-1].full_url


def test_a_binary_type_with_no_extractor_yields_no_text() -> None:
    """A PDF is skipped rather than stored as mojibake.

    A chunk of garbage still retrieves, and a citation to garbage is worse than
    no citation.
    """
    opener = FakeOpener({"oauth2": json.dumps({"access_token": "at"}).encode()})

    assert _reader(opener).extract_text(
        _file("pdf-1", "Scan.pdf", mime="application/pdf")
    ) == ""


def test_an_oversized_file_is_not_downloaded() -> None:
    opener = FakeOpener({"oauth2": json.dumps({"access_token": "at"}).encode()})
    huge = DriveFile(
        id="big",
        name="Archive.txt",
        mime_type="text/plain",
        modified_time="2026-04-01T10:00:00.000Z",
        size=50 * 1024 * 1024,
    )

    assert _reader(opener).extract_text(huge) == ""


def test_an_expired_access_token_is_refreshed_once_rather_than_failing() -> None:
    calls = {"n": 0}

    class Expiring(FakeOpener):
        def __call__(self, request):
            self.requests.append(request)
            if "oauth2" in request.full_url:
                return json.dumps({"access_token": "at"}).encode()
            calls["n"] += 1
            if calls["n"] == 1:
                raise urllib.error.HTTPError(
                    request.full_url, 401, "Unauthorized", {}, None  # type: ignore[arg-type]
                )
            return json.dumps({"files": []}).encode()

    assert list(_reader(Expiring({})).list_files()) == []
    assert calls["n"] == 2


def test_a_revoked_refresh_token_says_so() -> None:
    class Revoked(FakeOpener):
        def __call__(self, request):
            self.requests.append(request)
            raise urllib.error.HTTPError(
                request.full_url, 400, "Bad Request", {}, None  # type: ignore[arg-type]
            )

    with pytest.raises(DriveError) as excinfo:
        list(_reader(Revoked({})).list_files())

    assert "revoked" in str(excinfo.value)


# ---------------------------------------------------------------------------
# CLI surface
# ---------------------------------------------------------------------------

def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    register_rag_subparser(parser.add_subparsers(dest="memory_command"))
    return parser


def test_the_cli_requires_a_principal_and_never_takes_a_role() -> None:
    """A role asserted on the command line would be a role anyone can claim."""
    args = _parser().parse_args(
        ["rag", "--as", "leo_owner", "search", "tender deadline"]
    )

    assert (args.acting_as, args.rag_command) == ("leo_owner", "search")
    with pytest.raises(SystemExit):
        _parser().parse_args(["rag", "search", "x"])
    with pytest.raises(SystemExit):
        _parser().parse_args(
            ["rag", "--as", "leo_owner", "--role", "owner", "search", "x"]
        )


def test_ingest_drive_defaults_to_every_connected_account() -> None:
    args = _parser().parse_args(["rag", "--as", "leo_owner", "ingest-drive"])

    assert args.account is None  # resolved from the credential store
    assert args.limit == 50


def test_accounts_are_repeatable_on_the_command_line() -> None:
    args = _parser().parse_args(
        [
            "rag", "--as", "leo_owner", "ingest-drive",
            "--account", "a@x.com", "--account", "b@y.com", "--limit", "5",
        ]
    )

    assert args.account == ["a@x.com", "b@y.com"]
    assert args.limit == 5


def _summary(*, ingested: int = 0, unchanged: int = 0, failures: int = 0):
    from hermes_cli.rag_drive import IngestSummary

    return IngestSummary(
        account="leo@example.com",
        seen=ingested + unchanged + failures,
        ingested=ingested,
        unchanged=unchanged,
        failures=[f"doc {n}: HTTP 413" for n in range(failures)],
    )


def test_a_run_that_stored_nothing_and_failed_everything_is_not_a_success() -> None:
    """It runs from a timer, where exit 0 is all anyone reads."""
    assert total_failure([_summary(failures=3)])
    assert total_failure([_summary(failures=2), _summary(failures=1)])


def test_a_partial_failure_still_succeeds_and_a_clean_run_is_silent() -> None:
    """One unstorable export must not fail a pass that ingested the rest."""
    assert total_failure([_summary(ingested=9, failures=1)]) == ""
    assert total_failure([_summary(unchanged=40, failures=1)]) == ""
    assert total_failure([_summary(ingested=3)]) == ""
    assert total_failure([]) == ""
