"""Hand outgoing attachments to the WhatsApp bridge through its media folder.

The bridge's ``POST /send-media`` only reads files inside the folder it
reports as ``outboundMediaDir`` in ``GET /health`` (security review F8), so
each attachment is linked or copied there under a random name, sent, and
removed again. Bridges that predate the folder don't report one; then the
original path is sent unchanged.
"""

from __future__ import annotations

import contextlib
import os
import re
import secrets
import shutil
from typing import Iterator, Optional

_SAFE_EXT = re.compile(r"^\.[A-Za-z0-9]{1,10}$")


async def bridge_outbound_media_dir(session, base_url: str) -> Optional[str]:
    """Return the bridge's media folder from ``/health``, or ``None``."""
    try:
        import aiohttp

        async with session.get(
            f"{base_url}/health", timeout=aiohttp.ClientTimeout(total=5)
        ) as resp:
            if resp.status != 200:
                return None
            data = await resp.json()
    except Exception:
        return None
    media_dir = data.get("outboundMediaDir") if isinstance(data, dict) else None
    if isinstance(media_dir, str) and os.path.isabs(media_dir):
        return media_dir
    return None


@contextlib.contextmanager
def staged_for_bridge(file_path: str, media_dir: Optional[str]) -> Iterator[str]:
    """Yield a path inside *media_dir* holding *file_path*'s bytes."""
    if not media_dir:
        yield file_path
        return
    os.makedirs(media_dir, mode=0o700, exist_ok=True)
    ext = os.path.splitext(file_path)[1]
    if not _SAFE_EXT.match(ext):
        ext = ""
    staged = os.path.join(media_dir, f"out_{secrets.token_hex(8)}{ext.lower()}")
    try:
        try:
            os.link(file_path, staged)
        except OSError:
            shutil.copyfile(file_path, staged)
        yield staged
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(staged)
