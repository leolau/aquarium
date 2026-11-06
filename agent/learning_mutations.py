"""User-initiated edit/delete for journey nodes (learned skills + memories).

The journey graph (``agent.learning_graph``) gives every node a stable id:

- **skills** → the skill name (e.g. ``"debugging-hermes-desktop"``)
- **memories** → ``memory:<source>:<index>`` where ``source`` is ``shared``
  (the profile's ``MEMORY.md``), ``memory`` (the viewer's notes) or
  ``profile`` (the viewer's ``USER.md``), and ``index`` is the node's position
  in the combined card list (``agent.learning_graph.memory_sources`` order).
  Only the viewer's own files and the shared block are reachable; the shared
  block is writable by owner/admin only (FG-24).

This module maps a node id back to its on-disk home and performs the mutation,
shared by the CLI (``hermes journey delete|edit``), the TUI ``/journey`` overlay
(gateway RPCs), and the desktop GUI (REST). Deleting a skill *archives* it
(recoverable via ``hermes curator restore``); deleting a memory rewrites its
file. Pure stdlib + existing skill/memory helpers.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

_MEMORY_SOURCES = ("shared", "memory", "profile")


def parse_node_kind(node_id: str) -> str:
    return "memory" if node_id.startswith("memory:") else "skill"


def _parse_memory_id(node_id: str) -> tuple[str, int]:
    """``memory:<source>:<index>`` → (source, global_index)."""
    parts = node_id.split(":", 2)
    if len(parts) != 3 or parts[0] != "memory" or parts[1] not in _MEMORY_SOURCES:
        raise ValueError(f"bad memory node id: {node_id!r}")
    try:
        return parts[1], int(parts[2])
    except ValueError as exc:
        raise ValueError(f"bad memory node id: {node_id!r}") from exc


def _viewer(node_id: str, principal: Any) -> Any:
    """Resolve the viewer once per call (memory nodes only; skills need none)."""
    if parse_node_kind(node_id) != "memory":
        return principal
    from agent.learning_graph import resolve_viewer

    return resolve_viewer(principal)


def _memory_local_index(source: str, global_index: int, principal: Any = None) -> int:
    """Global card index → position within the source's own file.

    Cards come out grouped by file in ``memory_sources`` order, so a card's
    local index is the number of same-source cards before it.
    """
    from agent.learning_graph import _memory_cards

    cards = _memory_cards(principal)
    if not 0 <= global_index < len(cards):
        raise IndexError(f"memory index {global_index} out of range")
    if cards[global_index].get("source") != source:
        raise ValueError("memory node id is stale — refresh the graph")
    return sum(1 for c in cards[:global_index] if c.get("source") == source)


def _locate_memory(
    source: str, gidx: int, principal: Any = None, *, for_write: bool = False
) -> tuple[Path, list[str], int]:
    """Resolve a memory card to its file, all §-delimited entries, and local index.

    Entries come from ``MemoryStore._read_file`` — the same parser the memory
    tool uses — so journey indices stay aligned with what the graph renders.
    """
    from agent.learning_graph import memory_sources
    from tools.memory_tool import MemoryStore

    src = next((m for m in memory_sources(principal) if m.source == source), None)
    if src is None:
        raise ValueError("memory node id is stale — refresh the graph")
    if for_write and not src.editable:
        raise ValueError(
            "the shared memory block is editable by the profile owner or an admin only"
        )
    path = src.path
    if not path.exists():
        raise ValueError(f"{path.name} not found")
    chunks = MemoryStore._read_file(path)
    local = _memory_local_index(source, gidx, principal)
    if not 0 <= local < len(chunks):
        raise ValueError("memory node id is stale — refresh the graph")
    return path, chunks, local


# ── Inspect (edit prefill) ──────────────────────────────────────────────────


def node_detail(node_id: str, principal: Any = None) -> dict[str, Any]:
    """Current content for an edit prefill. ``content`` is the full SKILL.md
    (skills) or the raw memory chunk (memories)."""
    try:
        return _node_detail(node_id, _viewer(node_id, principal))
    except (ValueError, IndexError) as exc:
        return {"ok": False, "message": str(exc)}


def _node_detail(node_id: str, principal: Any = None) -> dict[str, Any]:
    if parse_node_kind(node_id) == "memory":
        source, gidx = _parse_memory_id(node_id)
        _, chunks, local = _locate_memory(source, gidx, principal)
        body = chunks[local].strip()

        return {"ok": True, "kind": "memory", "id": node_id, "label": body.splitlines()[0][:80], "content": body}

    from tools.skill_manager_tool import _find_skill

    found = _find_skill(node_id)
    if not found:
        return {"ok": False, "message": f"skill '{node_id}' not found"}
    skill_md = Path(found["path"]) / "SKILL.md"
    if not skill_md.exists():
        return {"ok": False, "message": f"SKILL.md missing for '{node_id}'"}

    return {
        "ok": True,
        "kind": "skill",
        "id": node_id,
        "label": node_id,
        "content": skill_md.read_text(encoding="utf-8"),
    }


# ── Delete ──────────────────────────────────────────────────────────────────


def delete_node(node_id: str, principal: Any = None) -> dict[str, Any]:
    try:
        return _delete_memory(node_id, _viewer(node_id, principal)) if parse_node_kind(node_id) == "memory" else _delete_skill(node_id)
    except (ValueError, IndexError) as exc:
        return {"ok": False, "message": str(exc)}


def _delete_skill(name: str) -> dict[str, Any]:
    from tools import skill_usage

    if skill_usage.get_record(name).get("pinned"):
        return {"ok": False, "message": f"'{name}' is pinned — unpin it first (hermes curator unpin {name})"}

    ok, message = skill_usage.archive_skill(name)
    if ok:
        _clear_skill_cache()

    return {"ok": ok, "message": f"archived '{name}' — restore with: hermes curator restore {name}" if ok else message}


def _delete_memory(node_id: str, principal: Any = None) -> dict[str, Any]:
    source, gidx = _parse_memory_id(node_id)
    path, chunks, local = _locate_memory(source, gidx, principal, for_write=True)

    del chunks[local]
    _write_memory(path, chunks)

    return {"ok": True, "message": f"deleted memory from {path.name}"}


# ── Edit ────────────────────────────────────────────────────────────────────


def edit_node(node_id: str, content: str, principal: Any = None) -> dict[str, Any]:
    try:
        return _edit_memory(node_id, content, _viewer(node_id, principal)) if parse_node_kind(node_id) == "memory" else _edit_skill(node_id, content)
    except (ValueError, IndexError) as exc:
        return {"ok": False, "message": str(exc)}


def _edit_skill(name: str, content: str) -> dict[str, Any]:
    from tools.skill_manager_tool import _edit_skill as _do_edit

    result = _do_edit(name, content)
    if result.get("success"):
        _clear_skill_cache()

        return {"ok": True, "message": f"updated '{name}'"}

    return {"ok": False, "message": result.get("error", "edit failed")}


def _edit_memory(node_id: str, content: str, principal: Any = None) -> dict[str, Any]:
    source, gidx = _parse_memory_id(node_id)
    body = content.strip()
    if not body:
        return {"ok": False, "message": "empty memory — use delete to remove it"}
    path, chunks, local = _locate_memory(source, gidx, principal, for_write=True)

    chunks[local] = body
    _write_memory(path, chunks)

    return {"ok": True, "message": f"updated memory in {path.name}"}


# ── Helpers ─────────────────────────────────────────────────────────────────


def _write_memory(path: Path, chunks: list[str]) -> None:
    """Atomic temp-file + rename via the memory tool, so a concurrent reader
    never sees a half-written file (and the §-join stays single-sourced)."""
    from tools.memory_tool import MemoryStore

    MemoryStore._write_file(path, [c.strip() for c in chunks if c.strip()])


def _clear_skill_cache() -> None:
    try:
        from agent.prompt_builder import clear_skills_system_prompt_cache

        clear_skills_system_prompt_cache(clear_snapshot=True)
    except Exception:
        pass
