"""Short refs mentioned in a chat turn (FG-36 PR 2).

When the sender's message names refs (``P12``, ``T345``, ``P12-R3``,
``C1024`` — any kind the resolver knows, so ``D``/``M`` join when their
resolvers land), a one-line description of each item **the sender may see**
is appended to that same user turn before it reaches the agent::

    Can you compare P12 with C1024?

    [Referenced items]
    - P12 · project · Monday digest · active · /projects/monday-digest
    - C1024 · chat · Q3 budget · open · /chat?session=…&profile=default

Prompt caching and role alternation are the constraints (AGENTS.md): the
block is part of the user's own turn and is persisted with it, so later turns
replay it byte-identically; the system prompt and earlier turns are never
touched and no synthetic message is inserted. Refs that resolve to nothing —
missing, hidden, unknown kind — are silently skipped (a ref never confirms a
hidden item exists), and at most :data:`MAX_EXPANDED` distinct refs expand.
"""

from __future__ import annotations

import logging
from typing import Awaitable, Callable, Optional

from hermes_cli import short_refs

logger = logging.getLogger(__name__)

#: Distinct refs expanded per message; the rest are left as typed.
MAX_EXPANDED = 5

#: First line of the appended block. agent-home hides the block in the
#: sender's bubble (`stripRefMentions` in `src/lib/chat/transcript.ts`).
BLOCK_HEADER = "[Referenced items]"

_FIELD_MAX = 120


def mentioned_refs(text: str, limit: int = MAX_EXPANDED) -> list[str]:
    """Canonical refs in ``text``, first mention first, deduplicated."""
    out: list[str] = []
    for raw in short_refs.REF_IN_TEXT_RE.findall(text or ""):
        parsed = short_refs.parse_ref(raw)
        if parsed is None:
            continue
        ref = str(parsed)
        if ref not in out:
            out.append(ref)
        if len(out) >= limit:
            break
    return out


def _clean(value) -> str:
    text = " ".join(str(value or "").split())
    return text if len(text) <= _FIELD_MAX else text[: _FIELD_MAX - 1] + "…"


def describe(item: dict) -> str:
    """``- P12 · project · Monday digest · active · /projects/digest``."""
    parts = [item.get("ref"), item.get("kind"), item.get("title"), item.get("status"), item.get("url")]
    return "- " + " · ".join(_clean(p) for p in parts if p)


def with_block(text: str, items: list[dict]) -> str:
    if not items:
        return text
    lines = "\n".join(describe(i) for i in items)
    return f"{text}\n\n{BLOCK_HEADER}\n{lines}"


async def expand_with(
    text: str,
    resolve: Callable[[str], Awaitable[Optional[dict]]],
    *,
    scan: Optional[str] = None,
) -> str:
    """``text`` plus the block for the refs in ``scan`` (default ``text``)
    that ``resolve`` answers. A resolver error skips that ref."""
    refs = mentioned_refs(scan if scan is not None else text)
    if not refs:
        return text
    items: list[dict] = []
    for ref in refs:
        try:
            item = await resolve(ref)
        except Exception:
            logger.warning("ref_mentions: could not resolve %s", ref, exc_info=True)
            item = None
        if item:
            items.append(item)
    return with_block(text, items)


async def expand_ref_mentions(request, text: str, *, principal, scan: Optional[str] = None) -> str:
    """:func:`expand_with` under the web request's caller (``GET /api/refs``
    authority; ``principal`` is the chat turn's own)."""
    from hermes_cli import refs_api

    async def _resolve(ref: str) -> Optional[dict]:
        return await refs_api.resolve_for_request(request, ref, principal=principal)

    return await expand_with(text, _resolve, scan=scan)
