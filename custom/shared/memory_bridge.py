#!/usr/bin/env python3
"""
Memory Bridge

Pushes facts from standalone triage agents (WhatsApp, email, calendar) into
the untrusted inbox-facts file ($HERMES_HOME/memories/INBOX_FACTS.md). The
facts come from messages other people wrote, so they never go into the
profile-wide MEMORY.md that every principal reads as shared memory (security
review F6). tools/memory_tool.py shows the inbox file to the owner only, quoted
as data under an "untrusted" header; see tools/inbox_memory.py.

Entries written by older versions of this bridge into MEMORY.md are moved to
the inbox file on the next write.

Memory entries use the § (section sign) delimiter, matching the format that
tools/memory_tool.py expects. Each fact is prefixed with a provenance tag
showing the source channel, date, and sender.

Configuration (read from the triage agent's config.json under the "memory" key):
    enabled            — if false, no-op (default: true)
    memory_file        — override path to the inbox file (default:
                         $HERMES_HOME/memories/INBOX_FACTS.md). Ignored if it
                         points at a curated memory file (MEMORY.md / USER.md).
    max_facts_per_batch — cap to prevent flooding memory (default: 10)
    max_file_chars     — rolling budget for the inbox file (default: 2200, the
                         memory tool's own file limit). When exceeded, the
                         OLDEST bridged entries are evicted.

The inbox file is injected into the owner's system prompt, so an unbounded
append here inflates every owner conversation's baseline context.
"""

import json
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path

from tools.inbox_memory import (
    ENTRY_DELIMITER,
    INBOX_FILENAME,
    file_lock,
    is_bridged_entry,
    read_entries,
    split_bridged,
    write_entries,
)

DEFAULT_MAX_FILE_CHARS = 2200

# Cache the config so we don't re-read config.json on every batch.
_config_cache = None
_config_path_cache = None


def _get_memory_config(config_path=None):
    """Read memory config from config.json. Cached per path."""
    global _config_cache, _config_path_cache
    if config_path and config_path == _config_path_cache and _config_cache is not None:
        return _config_cache

    config = {}
    if config_path and os.path.exists(config_path):
        try:
            with open(config_path, encoding='utf-8') as f:
                full_config = json.load(f)
            config = full_config.get('memory', {})
        except Exception:
            pass

    _config_cache = config
    _config_path_cache = config_path
    return config


def _get_memory_dir():
    hermes_home = os.environ.get('HERMES_HOME', '')
    if hermes_home:
        return Path(hermes_home) / 'memories'
    return Path.home() / '.hermes' / 'memories'


def _get_memory_file(config_path=None):
    """Resolve the inbox-facts path (never a file the memory tool curates)."""
    default = _get_memory_dir() / INBOX_FILENAME
    override = _get_memory_config(config_path).get('memory_file')
    if not override:
        return default
    path = Path(override)
    if path.name in ('MEMORY.md', 'USER.md'):
        print(f"[memory_bridge] Ignoring memory_file={override}: facts from "
              f"incoming messages must not go into curated memory; using {default}")
        return default
    return path


def _is_enabled(config_path=None):
    """Check if the memory bridge is enabled."""
    mem_cfg = _get_memory_config(config_path)
    return mem_cfg.get('enabled', True)


def _get_max_facts(config_path=None):
    """Get the max facts per batch cap."""
    mem_cfg = _get_memory_config(config_path)
    return mem_cfg.get('max_facts_per_batch', 10)


def _get_max_file_chars(config_path=None):
    mem_cfg = _get_memory_config(config_path)
    try:
        return int(mem_cfg.get('max_file_chars', DEFAULT_MAX_FILE_CHARS))
    except (TypeError, ValueError):
        return DEFAULT_MAX_FILE_CHARS


def _is_bridged(entry):
    return is_bridged_entry(entry)


def _fit_to_budget(entries, budget):
    """Evict the oldest bridged entries until the joined file fits ``budget``.

    Untagged entries (written by the agent's memory tool) are kept whatever
    happens; if they alone exceed the budget nothing bridged survives.
    """
    entries = list(entries)

    def size(items):
        return len(ENTRY_DELIMITER.join(items))

    while size(entries) > budget:
        idx = next((i for i, e in enumerate(entries) if _is_bridged(e)), None)
        if idx is None:
            break
        del entries[idx]
    return entries


def _take_legacy_entries(shared_file):
    """Remove bridged entries from the shared MEMORY.md; return them.

    Caller holds the shared file's lock. A file that does not round-trip
    (hand-edited) is left alone; the memory tool still keeps its bridged
    entries out of the shared block.
    """
    try:
        raw = shared_file.read_text(encoding='utf-8')
    except (OSError, IOError):
        return [], None
    entries = [e.strip() for e in raw.split(ENTRY_DELIMITER) if e.strip()]
    if raw.strip() != ENTRY_DELIMITER.join(entries):
        return [], None
    kept, legacy = split_bridged(entries)
    return legacy, kept


def remember_facts(facts, *, source, sender, config_path=None):
    """Append facts to the inbox-facts file using the § delimiter.

    Each fact is a self-contained statement. The owner's next session shows
    them in the untrusted inbox block of its system prompt.

    Args:
        facts: list of {"fact": str, "category": str} dicts
        source: 'whatsapp' | 'email' | 'calendar'
        sender: phone number or email of the sender
        config_path: path to the triage agent's config.json (optional)

    Returns:
        Number of facts successfully written, or 0 if disabled/failed.
    """
    if not _is_enabled(config_path):
        return 0

    if not facts or not isinstance(facts, list):
        return 0

    max_facts = _get_max_facts(config_path)
    facts = facts[:max_facts]  # cap to prevent flooding

    memory_file = _get_memory_file(config_path)

    # Ensure the directory exists
    memory_file.parent.mkdir(parents=True, exist_ok=True)

    # Build the text to append
    now = datetime.now(timezone.utc)
    date_str = now.strftime('%Y-%m-%d')
    time_str = now.strftime('%H:%M')

    entries = []
    for fact_entry in facts:
        if isinstance(fact_entry, dict):
            fact_text = fact_entry.get('fact', '').strip()
            category = fact_entry.get('category', '')
        elif isinstance(fact_entry, str):
            fact_text = fact_entry.strip()
            category = ''
        else:
            continue

        if not fact_text:
            continue

        # One line per fact: a newline could forge an entry delimiter and
        # split off text that no longer carries its provenance tag.
        fact_text = ' '.join(fact_text.split())
        provenance = f"[{source} {date_str} {time_str} from {' '.join(str(sender).split())}]"
        entry = f"{provenance} {fact_text}"
        entries.append(entry)

    if not entries:
        return 0

    shared_file = _get_memory_dir() / 'MEMORY.md'
    # Lock order: inbox, then shared. The memory tool only ever holds one.
    try:
        with file_lock(memory_file), file_lock(shared_file):
            legacy, shared_kept = _take_legacy_entries(shared_file)
            existing = read_entries(memory_file)
            combined = list(dict.fromkeys(legacy + existing + entries))
            combined = _fit_to_budget(combined, _get_max_file_chars(config_path))
            written = sum(1 for e in entries if e in combined)
            if written == 0 and not legacy:
                return 0
            write_entries(memory_file, combined)
            if legacy:
                # Inbox written first, so a failure here only leaves a
                # duplicate that the memory tool already keeps out of shared.
                write_entries(shared_file, shared_kept)
                print(f"[memory_bridge] Moved {len(legacy)} older fact(s) out of "
                      f"shared {shared_file} into {memory_file}")
    except Exception as e:
        print(f"[memory_bridge] Failed to write {memory_file}: {e}")
        return 0

    return written
