---
name: incomings
description: Read WhatsApp, email, calendar, Telegram arrivals.
version: 1.0.0
author: core
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [inbox, whatsapp, email, calendar, telegram, cli]
---

# Incomings Skill

Reads the unified inbox registry behind the agent-home `/inbox` — every
WhatsApp message, email, calendar event, and mirrored Telegram arrival —
from the terminal. Read-only: it never replies, sends, or marks anything.

## When to Use

- The user asks what came in on WhatsApp, email, or calendar ("did Ada
  write back?", "what arrived this week?", "any new meetings?").
- Finding one specific arrival among the channels — an invoice, a thread,
  an event — when `session_search` (conversation history) is the wrong
  store: inbound messages are not sessions.

## Prerequisites

- A Hermes install with an enrolled owner principal.
- The Supabase-backed datastore configured (true on any running box; the
  verbs report a clean error otherwise).

## How to Run

Use the `terminal` tool:

```
hermes incomings list [--surface whatsapp,email] [--sender NAME] [--since 7d] [--limit N]
hermes incomings search "invoice" [--surface email]
hermes incomings show <item-id>
```

## Quick Reference

| Command | Meaning |
|---|---|
| `hermes incomings list` | newest-first page (default 20, max 200 via `--limit`) |
| `list --surface whatsapp` | one channel only (`whatsapp`, `email`, `calendar`, `telegram`) |
| `list --sender "Ada"` | comma-separated sender names or ids |
| `list --since 7d` | ISO timestamp or relative `30d` / `12h` form; `--until` bounds the other end |
| `list --unremembered` | not yet kept in memory (`--remembered` for the opposite) |
| `hermes incomings search "text"` | full-text over sender, conversation, subject, body |
| `hermes incomings show <id>` | full body + attachments of one arrival |
| `--cursor <token>` | next page: re-run the `more:` line printed under a page |
| `--json` | machine-readable output on any verb |
| `hermes ref M512` | the arrival a user's short ref (`M512`) names: id, title, channel, profile |

## Procedure

1. `hermes incomings list` with the filters that match the question.
2. Read the full item ids at the end of each line.
3. `hermes incomings show <id>` for the complete body and attachments.
4. If a `more:` line was printed, copy it (it carries `--cursor`) for older
   pages.

## Pitfalls

- Only the first page is shown by default — raise `--limit` or follow
  `more:`; there is no total count by design.
- `show` needs the full id exactly as printed; prefixes do not resolve.
- "No arrival … visible to you" means absent *or* not yours — the registry
  deliberately gives the same answer for both.
- These verbs never write. To keep an arrival in memory, use the existing
  `hermes incomings remember <id>`.
- Search covers names and bodies, CJK included; quote multi-word text.

## Verification

`hermes incomings list --limit 3` exits 0 and prints ids; then
`hermes incomings show <one of those ids>` prints its full body.
