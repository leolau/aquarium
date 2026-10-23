"""Google Drive → layer-4 RAG ingestion (FG-21 P4).

Scope is *all of Drive*, per the deployment's decision: everything each
configured account can open, "Shared with me" included. Two consequences shape
this module, and both are deliberate:

**Ingestion is newest-first and resumable.** A full backfill of an established
Drive account is hours of embedding on a 4-vCPU box shared with the gateway, so
a run takes a ``--limit`` and walks ``modifiedTime desc``. The tenders you are
working on this week become searchable in the first minute; the 2019 archive
arrives over subsequent runs. A run that dies halfway leaves every document it
finished, and the next run skips them by content hash.

**Ingested documents stay private to the person who ingested them.** A file
shared with an account is not a file the whole instance may read, so every
document lands on ``private:<owner>`` and reaches another person only by the
same two mechanisms as memory: a downward role read, or an explicit grant. There
is deliberately no "ingest as shared" switch here — laundering someone's private
contract into instance-wide visibility would be silent and irreversible.

Credentials are the files the Google Workspace MCP server already stores per
account (``<email>.json``: refresh token, client id/secret, scopes), so
ingestion needs no new secret and no new consent screen. It reads with the
``drive.readonly`` scope those files already carry.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, Iterator, List, Optional, Protocol, Sequence

TOKEN_URL = "https://oauth2.googleapis.com/token"
DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files"
SOURCE_KIND = "gdrive"

#: Fields worth one request each. ``modifiedTime`` drives the newest-first walk,
#: ``owners`` and ``webViewLink`` make a citation checkable by a human.
_FILE_FIELDS = (
    "nextPageToken,files(id,name,mimeType,modifiedTime,size,webViewLink,"
    "owners(emailAddress))"
)

#: What can be turned into text without a converter shelling out. Google-native
#: documents export as plain text; PDFs and images are skipped rather than
#: stored as garbage, because a chunk of mojibake still retrieves.
EXPORTABLE_GOOGLE_MIMES = {
    "application/vnd.google-apps.document": "text/plain",
    "application/vnd.google-apps.presentation": "text/plain",
    "application/vnd.google-apps.spreadsheet": "text/csv",
}
DOWNLOADABLE_MIMES = {
    "text/plain",
    "text/markdown",
    "text/csv",
    "application/json",
    "text/html",
}

#: Drive query: every file the account can open, excluding folders and the bin.
#: ``mimeType != folder`` rather than an allowlist, so a new text type does not
#: need a code change to be noticed — it is skipped at extraction, with a reason.
LIST_QUERY = "trashed = false and mimeType != 'application/vnd.google-apps.folder'"

#: A hard ceiling on bytes fetched per file. A 200 MB export would be embedded
#: into thousands of chunks whose usefulness is near zero, and would stall the
#: run for everything behind it.
MAX_FILE_BYTES = 5 * 1024 * 1024


class DriveError(RuntimeError):
    """A Drive or OAuth call failed in a way the caller should report."""


@dataclass(frozen=True)
class DriveFile:
    """One Drive file, as far as ingestion cares."""

    id: str
    name: str
    mime_type: str
    modified_time: str
    size: Optional[int] = None
    web_view_link: str = ""
    owner_email: str = ""

    @property
    def exportable(self) -> bool:
        return (
            self.mime_type in EXPORTABLE_GOOGLE_MIMES
            or self.mime_type in DOWNLOADABLE_MIMES
        )


class DriveReader(Protocol):
    """The two Drive operations ingestion needs.

    A protocol rather than a concrete client so the orchestration below is
    testable without a Google account: the real client talks HTTPS, the test
    double is a dict.
    """

    def list_files(self, *, page_size: int = 100) -> Iterator[DriveFile]:
        ...

    def extract_text(self, file: DriveFile) -> str:
        ...


def credential_path(credentials_dir: Path | str, email: str) -> Path:
    """Where the Workspace MCP credential store keeps ``email``'s tokens."""
    name = urllib.parse.quote(email, safe="@._-") + ".json"
    return Path(credentials_dir).expanduser() / name


def discover_accounts(credentials_dir: Path | str) -> List[str]:
    """Accounts with a credential file, so a run needs no account list.

    The deployment adds accounts by completing consent, not by editing config;
    reading the directory keeps those two from drifting apart. The store also
    keeps its own bookkeeping there (``oauth_states.json`` while a consent is
    pending), so only email-named files count as accounts.
    """
    directory = Path(credentials_dir).expanduser()
    if not directory.is_dir():
        return []
    accounts: List[str] = []
    for path in sorted(directory.glob("*.json")):
        name = urllib.parse.unquote(path.stem)
        if "@" in name:
            accounts.append(name)
    return accounts


class GoogleDriveReader:
    """A minimal, stdlib-only Drive v3 reader over a stored refresh token.

    Deliberately not ``google-api-python-client``: that dependency is optional in
    this repo (``hermes-agent[google]``), and a nightly ingestion timer should
    not fail on a box where the extra was never installed. Two endpoints and a
    token refresh do not justify the import.
    """

    def __init__(
        self,
        credentials: Dict[str, object],
        *,
        opener: Callable[[urllib.request.Request], bytes] | None = None,
    ) -> None:
        self._credentials = credentials
        self._token = ""
        self._opener = opener or _read_url
        self.account = str(credentials.get("account") or "")

    @classmethod
    def from_file(cls, path: Path | str) -> "GoogleDriveReader":
        document = json.loads(Path(path).expanduser().read_text("utf-8"))
        missing = [
            key
            for key in ("refresh_token", "client_id", "client_secret")
            if not document.get(key)
        ]
        if missing:
            raise DriveError(
                f"{path} is not a usable credential file (missing: "
                f"{', '.join(missing)})"
            )
        scopes = document.get("scopes") or []
        if isinstance(scopes, list) and not any(
            "drive" in str(scope) for scope in scopes
        ):
            raise DriveError(
                f"{path} carries no Drive scope; re-run consent with "
                "'drive.readonly' before ingesting"
            )
        return cls(document)

    # -- auth ---------------------------------------------------------------

    def _access_token(self) -> str:
        if self._token:
            return self._token
        payload = urllib.parse.urlencode(
            {
                "client_id": self._credentials["client_id"],
                "client_secret": self._credentials["client_secret"],
                "refresh_token": self._credentials["refresh_token"],
                "grant_type": "refresh_token",
            }
        ).encode()
        request = urllib.request.Request(TOKEN_URL, data=payload, method="POST")
        request.add_header("Content-Type", "application/x-www-form-urlencoded")
        try:
            body = self._opener(request)
        except urllib.error.HTTPError as exc:
            raise DriveError(
                f"Drive token refresh rejected ({exc.code}). The account may "
                "have revoked access; re-run consent."
            ) from exc
        token = json.loads(body).get("access_token", "")
        if not token:
            raise DriveError("Drive token refresh returned no access token")
        self._token = str(token)
        return self._token

    def _get(self, url: str, params: Dict[str, str]) -> bytes:
        query = urllib.parse.urlencode(params)
        request = urllib.request.Request(f"{url}?{query}")
        request.add_header("Authorization", f"Bearer {self._access_token()}")
        for attempt in range(3):
            try:
                return self._opener(request)
            except urllib.error.HTTPError as exc:
                if exc.code == 401 and attempt == 0:
                    # An expired access token: drop it and refresh once.
                    self._token = ""
                    request.add_unredirected_header(
                        "Authorization", f"Bearer {self._access_token()}"
                    )
                    continue
                if exc.code in (429, 500, 502, 503) and attempt < 2:
                    time.sleep(1.5 * (attempt + 1))
                    continue
                raise DriveError(f"Drive request failed ({exc.code}): {url}") from exc
        raise DriveError(f"Drive request failed after retries: {url}")

    # -- reads --------------------------------------------------------------

    def list_files(self, *, page_size: int = 100) -> Iterator[DriveFile]:
        """Every readable file, newest modification first.

        ``includeItemsFromAllDrives`` plus ``supportsAllDrives`` is what makes
        "Shared with me" and shared drives part of "all of Drive"; without both,
        Drive silently returns only files the account owns.
        """
        page_token = ""
        while True:
            params = {
                "q": LIST_QUERY,
                "orderBy": "modifiedTime desc",
                "pageSize": str(max(1, min(page_size, 1000))),
                "fields": _FILE_FIELDS,
                "includeItemsFromAllDrives": "true",
                "supportsAllDrives": "true",
                "corpora": "allDrives",
            }
            if page_token:
                params["pageToken"] = page_token
            payload = json.loads(self._get(DRIVE_FILES_URL, params))
            for entry in payload.get("files", []):
                owners = entry.get("owners") or [{}]
                size = entry.get("size")
                yield DriveFile(
                    id=str(entry.get("id", "")),
                    name=str(entry.get("name", "")),
                    mime_type=str(entry.get("mimeType", "")),
                    modified_time=str(entry.get("modifiedTime", "")),
                    size=int(size) if size is not None else None,
                    web_view_link=str(entry.get("webViewLink", "")),
                    owner_email=str(owners[0].get("emailAddress", "")),
                )
            page_token = str(payload.get("nextPageToken", ""))
            if not page_token:
                return

    def extract_text(self, file: DriveFile) -> str:
        if file.size is not None and file.size > MAX_FILE_BYTES:
            return ""
        if file.mime_type in EXPORTABLE_GOOGLE_MIMES:
            body = self._get(
                f"{DRIVE_FILES_URL}/{file.id}/export",
                {"mimeType": EXPORTABLE_GOOGLE_MIMES[file.mime_type]},
            )
        elif file.mime_type in DOWNLOADABLE_MIMES:
            body = self._get(
                f"{DRIVE_FILES_URL}/{file.id}",
                {"alt": "media", "supportsAllDrives": "true"},
            )
        else:
            return ""
        if len(body) > MAX_FILE_BYTES:
            body = body[:MAX_FILE_BYTES]
        return body.decode("utf-8", errors="replace")


def _read_url(request: urllib.request.Request) -> bytes:
    with urllib.request.urlopen(request, timeout=60) as response:
        return bytes(response.read())


@dataclass
class IngestSummary:
    """What one ingestion run did, per account, in reportable terms."""

    account: str = ""
    seen: int = 0
    ingested: int = 0
    unchanged: int = 0
    skipped: int = 0
    chunks: int = 0
    failures: List[str] = field(default_factory=list)


async def ingest_drive(
    rag,
    principal,
    reader: DriveReader,
    *,
    limit: int = 50,
    page_size: int = 100,
    account: str = "",
    progress: Optional[Callable[[DriveFile, str], None]] = None,
) -> IngestSummary:
    """Ingest up to ``limit`` documents, newest modification first.

    ``limit`` counts *documents ingested or confirmed unchanged*, not files
    listed, so a run does not exhaust its budget on a folder of images. One
    file's failure never ends the run: it is recorded and the walk continues,
    because a single unreadable export should not block the newer documents
    behind it.
    """
    summary = IngestSummary(account=account or getattr(reader, "account", ""))
    for file in reader.list_files(page_size=page_size):
        if summary.ingested + summary.unchanged >= limit:
            break
        summary.seen += 1
        if not file.exportable:
            summary.skipped += 1
            if progress:
                progress(file, "skipped (no text extractor)")
            continue
        try:
            text = reader.extract_text(file)
        except DriveError as exc:
            summary.failures.append(f"{file.name}: {exc}")
            if progress:
                progress(file, f"failed: {exc}")
            continue
        if not text.strip():
            summary.skipped += 1
            if progress:
                progress(file, "skipped (no extractable text)")
            continue
        try:
            result = await rag.ingest(
                principal,
                source_kind=SOURCE_KIND,
                source_ref=file.id,
                title=file.name,
                text=text,
                source_modified_at=_parse_timestamp(file.modified_time),
            )
        except Exception as exc:
            # Extraction failures were carried; ingestion failures were not, so
            # one document the embedder refused ended the whole nightly pass
            # and every newer document behind it went un-ingested — for weeks,
            # because the timer's next run hit the same document first.
            summary.failures.append(f"{file.name}: {exc}")
            if progress:
                progress(file, f"failed: {exc}")
            continue
        if result.skipped and result.reason == "unchanged":
            summary.unchanged += 1
            if progress:
                progress(file, "unchanged")
            continue
        if result.skipped:
            summary.skipped += 1
            if progress:
                progress(file, f"skipped ({result.reason})")
            continue
        summary.ingested += 1
        summary.chunks += result.chunks
        if progress:
            progress(file, f"ingested ({result.chunks} chunks)")
    return summary


def _parse_timestamp(value: str):
    """Drive's RFC 3339 ``modifiedTime`` as an aware datetime, or ``None``."""
    from datetime import datetime

    text = (value or "").strip()
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None


def accounts_to_ingest(
    credentials_dir: Path | str, requested: Sequence[str]
) -> List[str]:
    """Resolve requested accounts against the ones that have credentials.

    An account named on the command line but absent from the credential store is
    an error rather than a silent no-op: "I ingested nothing" and "that account
    is not connected" are different facts.
    """
    available = discover_accounts(credentials_dir)
    if not requested:
        return available
    unknown = [account for account in requested if account not in available]
    if unknown:
        raise DriveError(
            "No credential file for: "
            + ", ".join(unknown)
            + (
                f" (connected: {', '.join(available)})"
                if available
                else " (no accounts are connected)"
            )
        )
    return list(requested)
