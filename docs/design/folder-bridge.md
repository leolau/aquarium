# Folder Bridge — local Mac folders, read-only, for the agent

**Status**: built, not yet deployed to production
**Owner**: agent-home infrastructure
**Source spec**: `folder-bridge-web-app-spec.md` (v1.0.0) — see
`plans/2026-09-13-folder-bridge.md` for the build plan and where this
deviates from the spec's literal wire shape and why.

## What it is

A browser page (`/files/bridge`) that lets a user grant the running Hermes
agent read-only access to local folders on their own Mac, via the browser's
File System Access API, without uploading anything. It is built as a second
capability on the existing `app-mcp` service (see `docs/design/app-mcp.md`)
rather than a new service — see "Why extend app-mcp" below.

## What it is not

- Not a file upload/sync feature. The bytes never leave the user's machine
  except when a specific `readFile`/`searchFiles` MCP call asks for them,
  and only for files inside a folder the user explicitly approved.
- Not always-on. Unlike the UI-introspection bridge (`AppMcpBridge`, mounted
  on every agent-home page), Folder Bridge only exists while the user has
  `/files/bridge` open and has pressed **Connect** — both because
  `showDirectoryPicker()` needs a real user gesture on that page, and
  because "the agent can read my files" should never be an ambient,
  easy-to-forget-about state.
- Not write-capable in v1 (per spec §3.1/§10) — no create/edit/delete.

## Why extend `app-mcp`, not build a new service

`app-mcp` already is: a ticket-authenticated WebSocket hub the browser
dials, paired with an MCP server (`FastMCP("app")`) whose tools forward a
command to the browser and await its structured result. That is the exact
shape the spec asks for (persistent WS to a cloud backend; cloud sends
tasks; browser executes and answers). Building a second, near-identical
service — new port, new secret, new systemd unit, new Caddy block — for a
feature that is architecturally identical to what is already deployed would
violate this repo's "extend, don't duplicate" norm (`AGENTS.md`) for no
benefit. Investigated and ruled out first: a custom Next.js server with a
`ws` dependency (`agent-home` has neither today, and adding one just to
duplicate `app-mcp` would be new permanent surface for zero new capability).

## Architecture

```
Browser (agent-home)                     Box
────────────────────                     ───
AppMcpBridge (always-on)  ──WSS──▶  app-mcp (existing service, extended)
  · UI introspection/control          · /app-mcp/ws         → UI hub (existing)
                                       · /app-mcp/folders/ws → folder hub (new)
FolderBridge (opt-in,     ──WSS──▶     · MCP endpoint 127.0.0.1:9220/mcp
  /files/bridge only)
  · showDirectoryPicker()                  ▲
  · Map<folderId, handle>                   │ mcp_servers: app:  (existing entry)
  · list/search/read, scoped            Hermes agent
    to approved handles only            approvals.tools (recommended):
      ▲                                   [mcp_app_folder_bridge_read_file,
      │ 60s HMAC ticket (same              mcp_app_folder_bridge_search_files,
      │  secret/route as app-mcp)           mcp_app_folder_bridge_import_file_approved]
  POST /api/app-mcp/ticket
  (BFF, signed session)
```

- Same ticket route, same shared secret (`APP_MCP_TICKET_SECRET` ==
  `AGENT_HOME_APP_MCP_SECRET`) as the existing UI bridge — a ticket only
  proves "this is user X right now"; which capability it unlocks is decided
  by which WS path the browser dials (`/app-mcp/ws` vs
  `/app-mcp/folders/ws`), routed inside one `_ws_handler` in
  `app_mcp/server.py`.
- `addFolder`/`removeFolder` are **not** server-issuable commands — only a
  real user gesture can open the native picker, so the browser manages its
  own folder registry (`agent-home/src/lib/folder-bridge/handles.ts`) and
  persists handles to IndexedDB (for "reconnect without re-picking"; the
  browser still re-verifies permission on every restore, per the File
  System Access API's own model — this never bypasses a permission prompt).
- The server-issuable, agent-facing operations are read-only:
  `listFolders`, `listDirectory`, `searchFiles`, `readFile`,
  `getFileMetadata` — each a `folder_bridge_*` MCP tool that forwards a
  command to whichever browser session is attached and awaits its answer
  (`app_mcp/hub.Hub`, reused unmodified from the UI bridge).

## Deliberate deviation from the spec's message envelope

The spec's JSON envelope (§4) is illustrative, not a contract to a system
that pre-existed it. `app-mcp` already has a working envelope
(`{type:"cmd",id,command}` down, `{type:"result",id,...}` up, correlated by
a `Future` + timeout in `Hub`); the Folder Bridge reuses it rather than
running two envelope shapes in one service. `addFolder`/`removeFolder`
likewise aren't wire commands (see above) even though the spec lists them
alongside the read operations in §3.3 — the picker's user-gesture
requirement makes that a client-only concern regardless of transport.

## Security posture

`folder_bridge_read_file` and `folder_bridge_search_files` (which return
snippets) reach **arbitrary local files the user approved on their own
Mac** — meaningfully more sensitive than `app_act`/`app_act_destructive`,
which are bounded by what the signed-in user could already do inside
agent-home. This is exactly the "reads must be gated too" case
`docs/deployment/mcp-approval-gating.md` already documents for other
providers: a prompt-injected instruction from an email or WhatsApp message
could otherwise ask the agent to read and exfiltrate a local file with no
human in the loop. `app-mcp/README.md` recommends gating both in
`approvals.tools`; `folder_bridge_list_folders`/`_list_directory`/
`_get_file_metadata` are left ungated by default (metadata only, same
sensitivity as `app_describe_page`).

**This is a config change the box owner makes deliberately** — it is not
turned on by deploying this code, and deploying/flipping it in production
`config.yaml` was explicitly left out of this pass (see the plan doc).

## "Launch this feature in chat"

No new magic-link mechanism was built for this. `/files/bridge` is a normal
agent-home page behind the existing login; the agent can just tell the user
to open **Files → Folder Bridge**. To make that natural:

- `/files/bridge` has a `PAGES` entry and a `HELP` guide
  (`app_mcp/pages.py`, `app_mcp/help.py`), so `app_pages`/`app_page_help`
  already know how to describe it — the same mechanism that lets the agent
  explain any other screen.
- `folder_bridge_state` (mirrors `app_state`) reports whether a session is
  currently connected, so the agent's chat reply can say "not connected —
  open Files → Folder Bridge" or "connected, 2 folders" without a
  special-purpose "give me a link" tool.

## Files

- Backend: `app-mcp/app_mcp/server.py` (folder hub, path routing,
  `folder_bridge_*` tools), `app_mcp/pages.py`, `app_mcp/help.py`,
  `app-mcp/tests/test_routing.py`, `app-mcp/README.md`,
  `app-mcp/deploy/app-mcp.env.example`.
- Frontend: `agent-home/src/lib/folder-bridge/{types,handles,fsOps,transport}.ts`
  (+ `fsOps.test.ts`), `agent-home/src/components/files/FolderBridgeView.tsx`,
  `agent-home/src/app/files/bridge/page.tsx`,
  `agent-home/src/types/file-system-access.d.ts` (ambient DOM types this
  API needs that TypeScript's bundled `lib.dom.d.ts` doesn't yet have), entry
  link in `agent-home/src/components/files/FilesView.tsx`.
- Deploy: `agent-home/deploy/Caddyfile.agent-home` (adds the
  `/app-mcp/ws` + `/app-mcp/folders/ws` proxy block — the former was,
  independent of this feature, missing from the checked-in Caddyfile
  entirely; fixed here since this file was already being touched).

## Known gap, stated plainly

Whether `app-mcp` itself is even running on the current production box was
not verified as part of this pass — `docs/deployment/PRODUCTION.md`'s
service catalog (post-Hetzner-migration) does not list `app-mcp` at all,
while `docs/design/app-mcp.md` says "built" from before that migration. This
needs a read-only check against the live box before anyone assumes Folder
Bridge (or the existing UI bridge) is reachable in production today.

## Import (binary-safe copy into Files)

`read_file` is UTF-8 text only and refuses binary files (`binary: true`).
For PDFs, `.numbers`/`.xlsx`, images, etc. the agent calls
`folder_bridge_import_file(folder_id, path)`: the browser resolves the handle,
POSTs the raw `File` to the agent-home BFF (`POST /api/files/import`), which
writes it to principal-scoped Storage, computes SHA-256 server-side and
registers a `file_assets` row (`surface=agent_home`, `conversation` =
`<folder label>/<relative path>` as provenance). The browser hashes the
original itself and returns `verified: sha256 matches` with the registry row.
Bytes never traverse the WebSocket or the model context.

Approval is two-tier, decided in the browser:

- Folder toggled **Trusted for import** on `/files/bridge` (session-only, never
  persisted): `folder_bridge_import_file` succeeds without a chat prompt — also
  in dispatcher-spawned runs.
- Otherwise it returns `needsApproval: true`; the agent falls back to
  `folder_bridge_import_file_approved`, which must be in `approvals.tools` so
  the user approves that file in chat. The `approved: true` flag it sends is
  only honoured because the tool is gated — deployments that leave it ungated
  turn it into an unconditional import.

## Network folders (office file shares through a VPN)

A user can also add **network folders** on `/files/bridge`: an SMB path
(`\\server\share\folder`, `smb://server/share/folder` or
`//server/share/folder`) reached through one of their saved Fortinet VPNs
(Settings → In&Out, kind `fortinet-vpn`). Unlike browser folders they live on
the server, so the agent can use them while the Bridge page is closed (cards,
scheduled jobs). The agent uses the same `folder_bridge_*` tools; there are no
new model tools.

| Piece | Where |
|---|---|
| Storage | credential kind `smb-folder`, provider `fortinet` (`hermes_cli/credential_store.py`): `vpn`, `share_path` (normalised `//server/share[/sub]`), optional `share_username`/`share_password` (secret, redacted, kept on edit)/`share_domain`, `trusted_for_import`. Never materialized. Private to its owner. |
| Manager | `hermes_cli/vpn_folders.py`: slugs (`$HERMES_HOME/vpn/state.json` → `folder_slugs`, stable across renames; folder id `net-<slug>`), views, `ensure` (connect the VPN if needed, then mount), test/disconnect/delete, internal list/import |
| User API | `/api/vpn/folders` (`hermes_cli/vpn_api.py`): `GET`, `POST`, `PUT /{name}`, `DELETE /{name}`, `POST /{name}/test`, `POST /{name}/disconnect`. Caller's own folders only; anyone else's is a 404. The VPN must be readable by the caller. |
| Mount | root helper `mount <spec>` / `umount` / `fstatus` / `fcheck <folder_slug>` (`deploy/hermes-vpn-helper`): read-only CIFS at `/opt/data/vpn-files/net-<slug>`, same options as the VPN's own share (`iocharset=utf8`, SMB 3.x/2.1, else 2.0; never 1.0), only through a connected VPN. If the tunnel doesn't reach the file server yet, the helper adds `<server_ip>/32` on it (after the box-overlap check), records it in the VPN state's `folder_routes`, and removes it when the last folder using it is unmounted. `down`/idle disconnect unmounts the VPN's folders and drops their routes. VPN slugs can't start with `net-`. |
| Agent side | `app-mcp/app_mcp/netfolders.py`: `net-*` ids are served by app-mcp from the mount (list/search/read/metadata; same shapes as the browser; `..` and symlinks refused). app-mcp runs as `hermes` without sudo, so it asks the dashboard to mount (`POST /api/internal/vpn/folders/ensure {id}`) and to import (`POST /api/internal/vpn/folders/import {id, path, approved}`); `GET /api/internal/vpn/folders` lists every folder on the box. |
| Internal auth | `Authorization: Bearer $APP_MCP_HERMES_TOKEN` (same value in `app-mcp/app-mcp.env` and the Hermes `.env`), verified by the `app-mcp-internal` token provider through the dashboard's token-auth seam (exact routes; fails closed without a ≥32-char token). Requests carrying `X-Forwarded-For`/`Forwarded` (i.e. via Caddy) are refused. |

Share login: the folder's own login when set, else the VPN entry's
`share_username`/`share_password`/`share_domain` (legacy entries only), else
the VPN login. A VPN entry is only the network connection; `hermes vpn
migrate-shares [--dry-run]` turns a legacy VPN's own share into a network
folder and strips the share and routes from the VPN.

Visibility: while mounted, any agent on the box may read a network folder
(box-level, like a VPN's own share), so `folder_bridge_list_folders` lists all
of them (`kind: "network"`, `trusted` = `trusted_for_import`). Agent calls
respect a VPN's `auto_connect: false` (the user must connect it); the user's
"Save & test" connects it.

Import: `folder_bridge_import_file` on a `net-*` folder works only when the
folder is trusted for import (else `needsApproval: true`), checked by app-mcp
and again by Hermes; `folder_bridge_import_file_approved` proceeds. Hermes
(root, holds the Storage key) opens the file without following symlinks,
hashes it, streams it to Storage under the folder owner's prefix
(`file_registry.storage_key`), checks the streamed hash matches, and registers
a `file_assets` row (`surface=agent_home`, `conversation=<folder name>/<path>`)
owned by the folder's owner. The result has the browser import's shape.
