# Custom Hermes Agent Pipeline

Custom WhatsApp + Email triage, escalation, and contact management pipeline built on top of [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent).

## Architecture

```
Gmail Account #1 (IMAP) --> Email Poller  --+
Gmail Account #2 (IMAP) --> Email Poller  --+
Gmail Account #N (IMAP) --> Email Poller  --+
                                            |
WhatsApp Phone #1 --> Bridge A (port 3000) -+
WhatsApp Phone #2 --> Bridge B (port 3001) -+
                                            |
                        +-------------------+
                        |
           +------------+-------------+
           |                          |
    Email Batcher (30s)      WA Batcher (5s)
           |                          |
           +------------+-------------+
                        |
               Shared Triage Agent (DeepSeek)
                        |
           +------------+-------------+------------+
           |            |             |             |
    Contact Auto-   Task/Note    Escalation    Merged Digest
    Management      Extraction   Push (TG)     (hourly, TG)
           |            |             |
           +------------+-------------+
                        |
               Single SQLite DB (whatsapp_data.db)
                        |
              +---------+---------+
              |                   |
       WA MCP Server       Email MCP Server
       (port 8650)         (port 8651)
```

## Directory Structure

```
custom/
├── email/                    # Email-specific services
│   ├── email_poller.py       # Multi-account Gmail IMAP polling daemon
│   ├── email_batcher.py      # 30s debounce batching, thread-aware
│   ├── email_mcp_server.py   # MCP server (17 tools) on port 8651
│   └── email_triage_agent.py # Email classification + task/note extraction
├── whatsapp/                 # WhatsApp-specific services
│   ├── batcher.py            # WA message batcher (5s window, Python)
│   ├── batcher.mjs           # WA message batcher (Node.js alternative)
│   ├── mcp_server.py         # WA MCP server on port 8650
│   ├── triage_agent.py       # WA message triage + task extraction
│   ├── escalation_pusher.py  # WA-only escalation pusher (v1)
│   └── digest_cron.py        # WA-only hourly digest (v1)
├── shared/                   # Cross-channel services
│   ├── contact_manager.py    # Unified contact auto-management + correlation
│   ├── escalation_pusher_v2.py  # Unified WA+Email escalation pusher
│   └── digest_cron_v2.py     # Merged WA+Email hourly digest
├── skills/
│   └── email-triage/         # Email-specific triage skill files
│       ├── SKILL.md
│       ├── classify-emails.md
│       ├── extract-deadlines.md
│       ├── signature-parsing.md
│       ├── spam-newsletter-filter.md
│       ├── thread-context.md
│       └── attachment-handling.md
├── migrations/               # DB schema setup + migration scripts
│   ├── migrate_phase1.py     # Unified contacts migration
│   └── create_email_tables.py # Email table creation
├── tests/                    # Integration and phase tests
│   ├── test_phase6.py
│   ├── test_phase7.py
│   ├── test_phase8.py
│   ├── test_phase9_integration.py
│   └── test_digest.py
└── config/
    ├── config.example.json   # Email config template
    └── .env.example          # Required environment variables
```

## Database Schema (Single SQLite DB)

All data lives in one SQLite DB with WAL mode:

| Table | Channel | Purpose |
|-------|---------|---------|
| `phones` | WhatsApp | Connected phone numbers |
| `messages` | WhatsApp | Raw WA messages |
| `wa_tasks` | WhatsApp | Extracted tasks |
| `wa_notes` | WhatsApp | Extracted notes |
| `wa_digests` | WhatsApp | Hourly digests |
| `email_accounts` | Email | Gmail account configs |
| `email_messages` | Email | Raw emails (deduped by Message-ID) |
| `email_tasks` | Email | Extracted tasks |
| `email_notes` | Email | Extracted notes |
| `email_digests` | Email | Hourly digests |
| `unified_contacts` | Shared | Master contact records |
| `contact_handles` | Shared | Phone + email handles per contact |
| `contact_merge_suggestions` | Shared | Pending merge confirmations |
| `escalations` | Shared | Urgent items pushed to Telegram |

## Unified Contact System

One contact can have multiple handles (phones + emails):

```
Contact: "Heidi Lui" (is_family=1)
  ├── phone: +85294066060  (WhatsApp)
  ├── email: heidi@gmail.com  (Personal)
  └── email: heidi@company.com  (Work)
```

Contact auto-management:
- **New handle** → auto-creates contact + runs correlation
- **Exact name match (single candidate)** → HIGH confidence → auto-merge
- **Cross-reference in message** → HIGH confidence → auto-merge
- **Same domain + similar name** → MEDIUM confidence → Telegram confirmation
- **Fuzzy name match (70%+)** → MEDIUM confidence → Telegram confirmation

## Setup

1. Copy `config/config.example.json` to `/opt/data/email-messages/config.json`
2. Copy `config/.env.example` to `/opt/data/email-messages/.env` and fill in values
3. Run migrations: `python3 migrations/migrate_phase1.py && python3 migrations/create_email_tables.py`
4. Start services (see docs/EMAIL_IMPLEMENTATION.md for service startup commands)

## Network exposure and auth

All custom HTTP servers bind `127.0.0.1` by default (security review F1):

| Service | Port | Auth | Override bind |
|---|---|---|---|
| Email MCP (`email/email_mcp_server.py`) | 8651 | `Authorization: Bearer $EMAIL_MCP_TOKEN` on everything except `/health`; refuses all calls if unset | `EMAIL_MCP_HOST` |
| WhatsApp MCP (`whatsapp/mcp_server.py`) | 8650 | `Authorization: Bearer $WHATSAPP_MCP_TOKEN` (same rules) | `WHATSAPP_MCP_HOST` |
| Telegram merge callback (`shared/telegram_callback_handler.py`) | 7902 | HMAC-signed `?exp=&sig=` links, 7-day expiry, key from `CALLBACK_SIGNING_SECRET` or `TELEGRAM_BOT_TOKEN` | `CALLBACK_BIND_HOST` |
| WA batcher health | 7900 | none (status only) | `WA_BATCHER_HEALTH_HOST` |
| Email poller health | 7901 | none (status only) | `EMAIL_HEALTH_HOST` |
| Calendar poller health | 7903 | none (status only) | `CALENDAR_HEALTH_HOST` |

No wildcard CORS header is sent, and tools run only from `POST /call` or
`POST /jsonrpc` (`GET /call?tool=...` now answers 405, so a link or `<img>` can
never run a tool). Register the MCP servers in Hermes `config.yaml`
with the token header, e.g.

```yaml
mcp_servers:
  email:
    url: http://127.0.0.1:8651/jsonrpc
    headers:
      Authorization: "Bearer ${EMAIL_MCP_TOKEN}"
```

The merge/keep buttons open in the owner's phone browser, so the callback
server must be reachable from there: put it behind the HTTPS reverse proxy and
set `CALLBACK_SERVER_BASE=https://<host>/<prefix>` for the triage processes.
If `CALLBACK_SERVER_BASE` is not set, the merge suggestion still arrives in
Telegram but without the Merge/Keep buttons (the old default pointed at a
released IP, 8.217.86.90). Links sent before this change are unsigned and are
refused (403).

## MCP Tools

### Email MCP (port 8651) - 9 email + 8 contact tools

**Email:** `email_search`, `email_get_recent`, `email_get_thread`, `email_list_tasks`, `email_list_notes`, `email_get_escalations`, `email_resolve_escalation`, `email_get_stats`, `email_list_accounts`

**Contact:** `contact_search`, `contact_get`, `contact_get_history`, `contact_merge`, `contact_split`, `contact_list`, `contact_pending_merges`, `contact_resolve_merge`

### WhatsApp MCP (port 8650) - 10 tools

`whatsapp_search_messages`, `whatsapp_get_recent`, `whatsapp_list_tasks`, `whatsapp_list_notes`, `whatsapp_list_contacts`, `whatsapp_get_escalations`, `whatsapp_resolve_escalation`, `whatsapp_get_stats`, `whatsapp_get_conversation`, `whatsapp_list_phones`
