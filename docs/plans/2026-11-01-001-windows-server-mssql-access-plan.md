---
title: "feat: SQL Server and Windows Server access through the Fortinet VPN"
status: approved — implementation in progress
date: 2026-11-01
type: feature
origin: user request — "what do I need to add to aquarium if I want it to access a Windows Server R1 and its MsSQL server in it?" then "write a plan on how to build up this support and commit it to the repo. Then, implement it."
depends_on:
  - hermes_cli/credential_store.py (CREDENTIAL_KINDS, KindSpec)
  - hermes_cli/vpn.py, hermes_cli/vpn_folders.py, deploy/hermes-vpn-helper (tunnel + /32 routes)
  - hermes_cli/email_mailboxes.py + tools/email_mailbox_tool.py (template for a per-person login + agent tool)
  - agent-home/src/components/settings/EmailMailboxes.tsx, VpnConnections.tsx (Settings → In&Out patterns)
---

# SQL Server and Windows Server access

## 1. Goal

A person can save a login to a Microsoft SQL Server (and, optionally, to the
Windows Server it runs on) in agent-home, and ask the agent questions that it
answers by querying that database. Typical target: an office Windows Server
(2008 R2 / 2012 R2 or newer) that is only reachable through the office's
Fortinet SSL-VPN. No SSH is needed on the Windows box.

| Need on the Windows side | Port | Used for |
|---|---|---|
| SQL Server with SQL authentication ("mixed mode") and a read-only login (`db_datareader`) | TCP 1433 (or the instance port) | Phase 1 queries |
| WinRM (built into Windows Server; `Enable-PSRemoting`) | TCP 5985 (HTTP) / 5986 (HTTPS) | Phase 3 PowerShell |
| SMB file shares | TCP 445 | Already supported (Network folders) |

## 2. What exists today

- **VPN:** Fortinet SSL-VPN logins (`fortinet-vpn` credentials) are connected
  by the root helper `deploy/hermes-vpn-helper`. The tunnel is split-tunnel
  with no routes. Mounting a Network folder (`smb-folder`) adds a `/32` route
  to the file server (`claim_folder_route` / `release_folder_routes`, state
  under `folder_routes`).
- **Per-person logins:** the unified credential store (`CREDENTIAL_KINDS`),
  with secret fields redacted from every view and `keep_secrets_on_put` for
  edit forms. `email-imap` + `tools/email_mailbox_tool.py` is the closest
  pattern: the password never leaves the server process and the tool acts
  only for the signed-in person (`tools.access_policy.current_principal`).
- **Nothing for SQL Server or WinRM:** no driver, credential kind, tool or route.

## 3. Design

### 3.1 Credential kind `mssql` (provider `mssql`)

Payload: `host`, `port` (default 1433), `database`, `username`, `password`;
optional `instance`, `encrypt` (`strict` | `on` | `off`, default `on`),
`trust_server_certificate` (bool), `legacy_tls` (bool, allows TLS 1.0/1.1 for
SQL Server 2008 R2/2012 that cannot do TLS 1.2), `vpn` (name of a readable
`fortinet-vpn` entry), `allow_writes` (bool, default false), `label`.
`secret_fields=("password",)`, `keep_secrets_on_put=True`,
`materialize=False` (agent terminals never see it), with a validator in the
style of `_validate_email_imap`. Visibility `private:<owner>`.

### 3.2 Driver

`python-tds` (pure Python TDS 7.x, no system ODBC packages), plus
`pyOpenSSL` for TLS. It goes in a new `mssql` extra pinned exactly and in
`tools/lazy_deps.py` (`LAZY_DEPS["mssql"]`), and the installer installs the
extra. Rationale: Microsoft ODBC Driver 18 needs Microsoft's apt repo and
system packages, and on Ubuntu 24.04 it refuses TLS 1.0 servers. With
python-tds the TLS context is ours, so `legacy_tls` can lower the minimum
version and `SECLEVEL` for that one connection only.

### 3.3 Reaching the server through the VPN

New helper commands in `deploy/hermes-vpn-helper`: `route <spec.json>` and
`unroute <spec.json>`. The spec is `{vpn_slug, user, host, port}`. They reuse
`lookup_share_ip` (public DNS, then the VPN's DNS bound to `pppN`) and the
same claim/release bookkeeping as folders, generalised from `folder_routes`
to a `host_routes` user list. They keep every existing check: no broad,
reserved or overlapping routes, and no change to the box DNS.
`hermes_cli/vpn.py` gets `ensure_host_route(vpn_cred, user, host)`, which
connects the VPN when needed, honouring `auto_connect: false` for agents.
Idle disconnect drops these routes like folder routes.

### 3.4 Backend module + API

`hermes_cli/mssql_connections.py` (like `email_mailboxes.py`): `list_mine`,
`save`, `delete`, `run_test`, `view_of` (with `password_set` only), and
`connect(payload)` returning a python-tds connection with login timeout 15 s.
`run_test` connects, runs `SELECT @@VERSION, DB_NAME()` and records the result
and server version. `hermes_cli/mssql_connections_api.py` adds
`GET/PUT/DELETE /api/mssql/connections[/{name}]` and `POST …/{name}/test`,
mounted in `web_server.py`, owner-scoped like the mailboxes API.

### 3.5 Agent tool `mssql_query` (toolset `mssql`)

Following the footprint ladder, this is a service-gated tool: `check_fn` passes
only when the driver is importable. It is added to `_HERMES_CORE_TOOLS` and
`hermes-api-server` (the agent-home platform; see the `email_mailbox` lesson).
Actions:

- `list_connections`
- `list_tables` (`INFORMATION_SCHEMA.TABLES`)
- `describe` (columns, types, keys)
- `query` (one statement)

Safety:

- **Read-only by default.** The statement must start with `SELECT` or `WITH`,
  must not contain `INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|TRUNCATE|EXEC|GRANT|REVOKE|DENY|BACKUP|RESTORE|SHUTDOWN|xp_`,
  and must not contain `;` followed by another statement. It runs inside
  `SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED`, `BEGIN TRAN … ROLLBACK`.
  The real guarantee is the read-only SQL login; the guide says so.
- **Writes** only when the owner set `allow_writes`. They go through the
  existing approval prompt (`approvals`), with the statement shown.
- **Limits:** at most 500 rows returned (`truncated: true` beyond that), 30 s
  query timeout, cells capped at 2,000 characters, and the total result capped
  at about 200 KB.
- The password never appears in results or errors (redacted like
  `email_mailbox`).

### 3.6 agent-home UI

Settings → In&Out gets a "SQL Server databases" section,
`components/settings/SqlServerConnections.tsx`, modelled on
`EmailMailboxes.tsx`:

- Form fields: host, port, database, user, password and encryption options.
- The `legacy_tls` checkbox is explained as "older Windows Server 2008/2012".
- A VPN picker lists the caller's VPNs, and owners get an "Allow changes" switch.
- Test button, status chip, and en + zh-Hant strings.
- BFF routes under `agent-home/src/app/api/mssql/…`, with `route-roles.json` entries.

### 3.7 Phase 3: Windows Server PowerShell (WinRM), optional

Credential kind `winrm` with host, port (5985/5986), transport (`ntlm` |
`kerberos` | `credssp`), username, password, `vpn`, `verify_tls` and
`legacy_tls`. It uses the `pypsrp` driver (extra `winrm`). Tool
`windows_powershell` (toolset `winrm`) has these actions:

- `run`: every command goes through the approval prompt.
- `get_service`, `get_eventlog` and `disk_free`: fixed read-only cmdlets with
  no approval needed.

Output is capped like `terminal`. It uses the same VPN route mechanism (§3.3).

## 4. Phases and PRs

1. **PR A: SQL Server end to end.** §3.1–3.6: helper `route`/`unroute` and
   `vpn.ensure_host_route`, the `mssql` kind, module, API, tool, UI and
   installer extra. Tests:
   - helper route bookkeeping with stubbed `ip`;
   - kind validation;
   - API owner scoping and password redaction;
   - tool read-only guard (allowed and denied statements), limits, approval
     path for writes, and registration in `hermes-api-server`;
   - UI vitest for the form, test button and hidden owner switch.

   python-tds is mocked: no network in tests.
2. **PR B: guides.** Installation Guide (SQL login on the Windows side,
   firewall, VPN) and User Guide ("ask the agent about the sales table"), with
   rebuilt PDFs.
3. **PR C: WinRM (§3.7)**, after PR A because it reuses the route helper.

Each PR targets `develop`. After merge, deploy to prod with
`/opt/data/deploy-hermes.sh develop`, reinstall the root helper (it is a
root-owned copy, see PRODUCTION.md §9), then smoke-test.

## 5. Risks

- **Old TLS:** SQL Server 2008 R2/2012 without TLS 1.2 updates needs
  `legacy_tls`; recommend patching the server instead.
- **Agent-generated SQL:** keyword filters can be bypassed. The read-only
  database login is the control that matters, and the UI asks for one.
- **Named instances** need SQL Browser (UDP 1434) or an explicit port. We
  require an explicit port, with `instance` used only for display and login.
- **Data exposure:** query results enter the model context. Row and size caps
  limit this; people should only connect databases they may share with the
  model provider.
