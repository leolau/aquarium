# VPN folder mounts that survive reconnects

Date: 2026-11-29

## Why

P7 run 4's intake card blocked twice on "reconnect the drive": the
Jensen (NEW) share is a Files → Bridge network folder whose SMB mount is
**lazy** — `vpn_folders.ensure()` mounts it on first `folder_bridge_*` use
— and **dies with the tunnel**. The VPN auto-reconnected (idle_minutes 0),
but nothing re-mounted the folder, so kanban workers kept seeing an empty
`/opt/data/vpn-files/net-jensen-new` even though the VPN reported
connected. Workers hold no bridge tools and no app-mcp token, so they
could not self-heal.

## (1) Auto-remount on (re)connect

- `vpn_folders.ensure()` now records `auto_mount: true` on the folder's
  state entry when a mount succeeds; `vpn_folders.disconnect()` clears it
  (folder deletion drops the entry wholesale via `_drop_slug`).
- New `vpn_folders.remount_for_vpn(vpn_cred, *, connected)` — mounts every
  box folder riding that VPN that carries the flag; per-folder failures
  record `last_error` on the folder, never raise.
- `vpn._connect` calls it after the tunnel reports `connected`, covering
  every path — user connect, `trust`, `test`, `ensure_host_route`, the
  auto-reconnect sweeper, and `vpn_folders.ensure` itself. Lazy import
  (vpn_folders imports vpn). Any remount failure is logged, never fails
  the connect. `connected=True` skips a redundant status probe (the
  caller just saw `state == "connected"`).

## (2) `hermes vpn ensure-folder <name-or-id>` CLI

A thin wrapper over `vpn_folders.ensure()`: resolves a `net-*` id via
`find_by_id`, a name via `box_folders()` (box-wide — a run worker acts as
the box owner; the folder's creator is irrelevant). Prints
`name: mounted at <path> (read-only)` or the error; exit 0/1; `--json`
supported. Lets a playbook step self-heal — e.g. P7's intake card:
`hermes vpn ensure-folder net-jensen-new` before `ls`.

## Tests (test_vpn_folders.py)

- reconnect remounts flagged folders on that VPN;
- folders never ensured are not mounted on connect;
- explicit folder disconnect clears the flag;
- a mount failure records `last_error` but the connect still succeeds;
- the CLI resolves by both `net-` id and name.
