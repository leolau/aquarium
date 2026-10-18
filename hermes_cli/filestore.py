"""Supabase Storage from Python: put the bytes somewhere durable and private.

agent-home already writes uploads into a private bucket through its BFF; the
gateway side had nowhere to put an attachment except a scratch directory that
is pruned after a day. This is the missing half — the same bucket, the same
key layout, reached over the Storage REST API so the Python side needs no
Supabase SDK.

Reads are never direct: a caller that has already checked the principal may
mint a short-lived signed URL, which is what the browser follows. The bucket
stays private, and an object key is never a capability on its own.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Optional

#: Bucket shared with agent-home, whose ``AGENT_HOME_MEDIA_BUCKET`` names the
#: same objects. One bucket keeps a file's key stable no matter which surface
#: it arrived on.
DEFAULT_BUCKET = "agent-home-media"

#: How long a view/download link stays valid. Long enough to open a PDF, short
#: enough that a link pasted elsewhere stops working.
DEFAULT_SIGNED_URL_TTL = 300


def _terminal_hint() -> str:
    from tools.terminal_db_credentials import hidden_hint

    return hidden_hint()


class StorageNotConfigured(RuntimeError):
    """Raised when the Storage credentials are absent.

    Callers treat this as "skip registration", never as a fatal error: a file
    arriving must not fail the conversation it arrived in.
    """


@dataclass(frozen=True)
class SupabaseStorage:
    """Minimal Storage client: upload, sign, download, remove."""

    url: str
    service_key: str
    bucket: str = DEFAULT_BUCKET
    timeout: float = 30.0

    @classmethod
    def from_env(cls, *, bucket: Optional[str] = None) -> "SupabaseStorage":
        """Build from ``SUPABASE_URL`` / ``SUPABASE_SERVICE_ROLE_KEY``.

        These are credentials, so they live in ``.env`` rather than
        ``config.yaml`` — the bucket name, which is not a secret, is
        configurable through ``AGENT_HOME_MEDIA_BUCKET`` for parity with
        agent-home.
        """
        url = (os.environ.get("SUPABASE_URL") or "").strip().rstrip("/")
        key = (
            os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
            or os.environ.get("SUPABASE_SERVICE_KEY")
            or ""
        ).strip()
        if not url or not key:
            raise StorageNotConfigured(
                "Supabase Storage is not configured; set SUPABASE_URL and "
                "SUPABASE_SERVICE_ROLE_KEY in .env (the same values "
                "agent-home.env carries)." + _terminal_hint()
            )
        name = (
            bucket
            or os.environ.get("AGENT_HOME_MEDIA_BUCKET")
            or DEFAULT_BUCKET
        ).strip()
        return cls(url=url, service_key=key, bucket=name)

    @property
    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.service_key}",
            "apikey": self.service_key,
        }

    def _object_url(self, path: str) -> str:
        return f"{self.url}/storage/v1/object/{self.bucket}/{path.lstrip('/')}"

    async def upload(
        self,
        path: str,
        data: bytes,
        *,
        content_type: str = "application/octet-stream",
        upsert: bool = True,
    ) -> str:
        """Store ``data`` at ``path``; returns the path.

        ``upsert`` is on because keys are content-addressed: re-uploading the
        same file writes identical bytes to the same key, and a conflict there
        is noise rather than information.
        """
        import httpx

        headers = dict(self._headers)
        headers["Content-Type"] = content_type or "application/octet-stream"
        headers["x-upsert"] = "true" if upsert else "false"
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.post(
                self._object_url(path), content=data, headers=headers
            )
        if response.status_code >= 400:
            raise RuntimeError(
                f"Supabase Storage upload failed ({response.status_code}): "
                f"{response.text[:200]}"
            )
        return path

    async def upload_stream(
        self,
        path: str,
        chunks: Any,
        *,
        size: int,
        content_type: str = "application/octet-stream",
        upsert: bool = True,
    ) -> str:
        """Like :meth:`upload`, streaming ``chunks`` (an async iterator of
        bytes, ``size`` bytes in total) instead of holding the file in memory."""
        import httpx

        headers = dict(self._headers)
        headers["Content-Type"] = content_type or "application/octet-stream"
        headers["Content-Length"] = str(size)
        headers["x-upsert"] = "true" if upsert else "false"
        timeout = httpx.Timeout(self.timeout, write=None, read=max(self.timeout, 300.0))
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(
                self._object_url(path), content=chunks, headers=headers
            )
        if response.status_code >= 400:
            raise RuntimeError(
                f"Supabase Storage upload failed ({response.status_code}): "
                f"{response.text[:200]}"
            )
        return path

    async def signed_url(
        self,
        path: str,
        *,
        expires_in: int = DEFAULT_SIGNED_URL_TTL,
        download_name: str = "",
    ) -> str:
        """A short-lived URL for one object. The caller checks access first."""
        import httpx

        payload: dict[str, object] = {"expiresIn": int(expires_in)}
        if download_name:
            payload["download"] = download_name
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.post(
                f"{self.url}/storage/v1/object/sign/{self.bucket}/{path.lstrip('/')}",
                json=payload,
                headers=self._headers,
            )
        if response.status_code >= 400:
            raise RuntimeError(
                f"Supabase Storage sign failed ({response.status_code}): "
                f"{response.text[:200]}"
            )
        signed = str(response.json().get("signedURL") or "")
        if not signed:
            raise RuntimeError("Supabase Storage returned no signedURL")
        return f"{self.url}/storage/v1{signed}" if signed.startswith("/") else signed

    async def download(self, path: str) -> bytes:
        """Fetch the bytes back — used by ingestion, never by a browser."""
        import httpx

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.get(
                self._object_url(path), headers=self._headers
            )
        if response.status_code >= 400:
            raise RuntimeError(
                f"Supabase Storage download failed ({response.status_code}): "
                f"{response.text[:200]}"
            )
        return response.content

    async def remove(self, path: str) -> None:
        """Delete one object. The registry row's deletion is the caller's job."""
        import httpx

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.delete(
                self._object_url(path), headers=self._headers
            )
        if response.status_code >= 400 and response.status_code != 404:
            raise RuntimeError(
                f"Supabase Storage delete failed ({response.status_code}): "
                f"{response.text[:200]}"
            )

    async def list_objects(
        self, prefix: str = "", *, limit: int = 1000
    ) -> list[dict]:
        """List objects under ``prefix``. Returns ``[{name, id, created_at, metadata}]``.

        Used by the backfill command to discover pre-existing objects that
        predate the registry. Each entry's ``name`` is the full object key
        (the ``storage_path``), and ``created_at`` is the object's upload time.
        """
        import httpx

        url = (
            f"{self.url}/storage/v1/object/list/{self.bucket}"
            f"?prefix={prefix}&limit={limit}"
        )
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.post(url, headers=self._headers)
        if response.status_code >= 400:
            raise RuntimeError(
                f"Supabase Storage list failed ({response.status_code}): "
                f"{response.text[:200]}"
            )
        items = response.json()
        if not isinstance(items, list):
            return []
        return items
