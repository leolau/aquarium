# app-mcp — the agent's eyes and hands on agent-home

app-mcp is internal app infrastructure: a standalone service that lets the
Hermes agent **see** and **drive** the agent-home UI at runtime, and (Folder
Bridge) read local files the user has explicitly approved from their own
Mac.

Three capabilities, exposed as MCP tools (`mcp_app_*` on the agent side):

1. **Introspection** — what page the user is on, which element they last
   touched, and a live, detailed description of every interactive element on
   the page (role, accessible name, value, state). Descriptions come from the
   live DOM — there is no registry to drift.
2. **Control** — click, type, select, focus, read, scroll, navigate. Safe
   actions run immediately; anything destructive (delete / archive / send /
   submit …) must go through `app_act_destructive`, which Hermes gates behind
   its tool-approval flow, so the user approves in-chat before it happens.
3. **Folder Bridge** — list/search/read within local folders on the user's
   Mac that they explicitly approved via the browser's File System Access
   API at `/files/bridge`. Read-only; nothing outside an approved folder is
   ever reachable. See "Why Folder Bridge reads are recommended-gated" below.

**Awareness is automatic**: the agent-home browser bridge reports page +
last-active element to this service, and every chat turn sent from the app
carries a one-line `[app context: …]` ahead of the message (see
`agent-home/src/lib/chat/ui-context.ts`). The user can say "this page" or
"the button I'm on" and the agent knows what they mean. Folder Bridge is
opt-in and separate: nothing is shared until the user opens `/files/bridge`
and explicitly approves folders there.

## Architecture

```
Browser (agent-home)                     Box
────────────────────                     ───
AppMcpBridge (client)   ──WSS──▶  app-mcp (this service)
  · reports page + focus            · WS hub      127.0.0.1:9221
  · executes commands                 · /app-mcp/ws         → UI hub
                                       · /app-mcp/folders/ws → folder hub
FolderBridge (client,   ──WSS──▶     · MCP endpoint 127.0.0.1:9220/mcp
  /files/bridge only)
  · showDirectoryPicker()                ▲
  · list/search/read locally              │ mcp_servers: app:
      ▲                                Hermes agent (tools/mcp_tool.py)
      │ 60s HMAC ticket (both)        approvals.tools: [mcp_app_app_act_destructive,
  POST /api/app-mcp/ticket                  mcp_app_folder_bridge_read_file,
  (BFF, signed session)                     mcp_app_folder_bridge_search_files]
```

- **Auth**: the browser never shares its session cookie with this service.
  The agent-home BFF (which owns authentication) mints a 60-second
  HMAC-signed ticket (`<user_id>.<expiry_ms>.<sig>`); the service verifies it
  with the shared secret (`APP_MCP_TICKET_SECRET` ==
  `AGENT_HOME_APP_MCP_SECRET`). The same ticket/secret authenticates both WS
  paths — a ticket only proves "this is user X right now"; the browser picks
  which capability it wants by which path it dials.
- **Exposure**: nothing public except Caddy's `/app-mcp/ws` and
  `/app-mcp/folders/ws` reverse proxies on the agent-home origin. The MCP
  endpoint is loopback-only.
- **Graceful degradation**: no secret configured → ticket route answers 503,
  the bridge retries quietly, everything else works. Service down → MCP tools
  return a structured "no app/folder session connected" error.

## MCP tools

| Tool | Purpose |
|---|---|
| `app_state` | Current page + last-active element + connection status |
| `app_pages` | The app's page map with the current page marked (and whether a guide exists) |
| `app_page_help` | Usage guide for the current page (or a given path): what it is for, how to use it end to end, what the options mean, who may do what. Sub-pages inherit their feature's guide (`app_mcp/help.py`) |
| `app_describe_page` | Live snapshot: every interactive element with id/role/name/state |
| `app_act` | Safe actions (click/type/select/focus/read/scroll/navigate/snapshot); refuses destructive-looking targets |
| `app_act_destructive` | Same, for destructive actions — gated by `approvals.tools` |
| `folder_bridge_state` | Whether a Folder Bridge browser session is connected |
| `folder_bridge_list_folders` | The user's currently-approved folders (id, label, permission status) |
| `folder_bridge_list_directory` | List a directory inside an approved folder |
| `folder_bridge_search_files` | Search by filename/snippet across approved folders — **recommend gating** |
| `folder_bridge_read_file` | Read a file's content — **recommend gating** |
| `folder_bridge_get_file_metadata` | A file's size/modified time without reading it |
| `folder_bridge_import_file` | Copy a file byte-for-byte into Files (any type) — browser accepts it only for folders the user marked "trusted for import" |
| `folder_bridge_import_file_approved` | Same, for untrusted folders — **gate this**; the in-chat approval is what lets the browser accept it |

### Network folders

Besides browser folders, `folder_bridge_*` serve **network folders** (ids
`net-…`, `kind: "network"`): office SMB shares the Hermes server mounts
read-only through a user's Fortinet VPN at `/opt/data/vpn-files/net-<slug>`.
app-mcp reads those mounts itself (`app_mcp/netfolders.py`), so they work with
no browser connected, and asks the Hermes dashboard to mount a folder or
import a file through `/api/internal/vpn/folders*` with
`APP_MCP_HERMES_TOKEN` (see `deploy/app-mcp.env.example`). Design:
`docs/design/folder-bridge.md` "Network folders".

### Why Folder Bridge reads are recommended-gated

`app_act`/`app_act_destructive` are bounded by what the signed-in user could
already do in agent-home. `folder_bridge_read_file` and
`folder_bridge_search_files` reach **arbitrary local files on the user's own
Mac** that they approved — new blast radius, and exactly the "reads must be
gated too" case `docs/deployment/mcp-approval-gating.md` calls out for other
providers (a prompt-injected instruction from an email/WhatsApp message could
otherwise ask the agent to read and exfiltrate a local file with no human in
the loop). `folder_bridge_list_folders`/`_list_directory`/`_get_file_metadata`
are left ungated by default (names/sizes/timestamps only, same sensitivity as
`app_describe_page`); widen to `mcp_app_folder_bridge_*` for maximum caution.

## Hermes wiring (box config.yaml)

```yaml
mcp_servers:
  app:
    url: "http://127.0.0.1:9220/mcp"
    # Send the chat's user id with every call (MCP `_meta`). app-mcp routes
    # UI and Folder Bridge commands to THAT user's browser only and refuses
    # calls without it, so this is required.
    forward_principal: true
    # Per-tool-call deadline on the agent side (default 300 s). A large
    # folder import uploads browser → BFF → Storage and can take tens of
    # minutes — the hub-side timeout is a *silence* deadline kept alive by
    # browser progress pings, so this is the only real total cap.
    timeout: 3600

approvals:
  tools:
    - mcp_app_app_act_destructive
    - mcp_app_folder_bridge_read_file
    - mcp_app_folder_bridge_search_files
    - mcp_app_folder_bridge_import_file_approved
```

`folder_bridge_import_file` (no suffix) is deliberately left ungated: the
browser refuses it unless the user toggled "trusted for import" on that folder
in the current `/files/bridge` session, so the human decision has already been
made — per folder instead of per file. Trust is never persisted; it resets on
every page load. Imported bytes go browser → agent-home BFF
(`POST /api/files/import`) → Storage + `file_assets`; they never traverse the
WebSocket or the model context, which is why binary files survive intact
(`read_file` refuses non-UTF-8 files instead of decoding them lossily).

Restart the gateway after changing either block. This is a deliberate,
owner-made config change on the production box — it is not turned on by
merely deploying this code.

## Running

```bash
# dev
APP_MCP_TICKET_SECRET=$(openssl rand -hex 32) python -m app_mcp.server

# tests (stdlib + pytest only)
python -m pytest
```

Production install: `deploy/app-mcp.service` + `deploy/app-mcp.env.example`
(see the headers of those files). The service reuses the hermes-agent venv —
`mcp` and `websockets` are already pinned there.
