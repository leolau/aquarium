---
name: fortinet-vpn
description: "hermes vpn CLI: connect a configured Fortinet VPN; office file shares are network folders read one folder at a time through folder_bridge_* tools (read-only)."
version: 1.2.0
author: core
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [VPN, Fortinet, Files, Network, CLI]
---

# Fortinet VPN (Private networks)

Some of the user's files live on an office file server that is only reachable
over their Fortinet VPN. The user sets each VPN up in agent-home
**Settings → In&Out → Private networks (VPN)**: a VPN is only the network
connection. Each file share is a separate **network folder** in
**Files → Bridge**, mounted **read-only** through its VPN when first used.
Older VPN entries may still have their own share mounted at
`/opt/data/vpn-files/<slug>`.

## When to use

- The user asks about a file or folder that is "on the office server", "on the
  share", "on the S: drive", "in the company files", or under a path such as
  `\\fileserver01\Shared\...`.
- A task, card or cron job says the input files are behind a VPN.

## Network folders (Folder Bridge)

The user may also have saved **network folders** in Files → Bridge: one
folder on an office file server, reached through one of their VPNs. Use the
Folder Bridge tools for those, not `hermes vpn`:

- `folder_bridge_list_folders` lists them with `kind: "network"` and ids
  `net-…` (they work with no browser connected).
- `folder_bridge_list_directory`, `folder_bridge_search_files`,
  `folder_bridge_read_file`, `folder_bridge_get_file_metadata` with that id
  connect the VPN and mount the folder on first use (read-only).
- `folder_bridge_import_file` copies a file into Files when the folder is
  "trusted for import"; otherwise use `folder_bridge_import_file_approved` so
  the user approves it in chat.

### Browse one folder at a time

Office shares can hold tens of thousands of files behind a slow VPN link.
An agent that ran 12 parallel `find`s over a 26,000-file share jammed the
link and every call timed out. So:

- Start at the root with `folder_bridge_list_directory`, then open only the
  sub-folder you need, one call after another.
- Never walk a whole share recursively: no `find`, `ls -R`, `du`, `tree`,
  `os.walk` or `glob("**")` on `/opt/data/vpn-files/...`, and no repeated
  listing of every sub-folder.
- Never run listings or searches in parallel on the same share (no
  concurrent tool calls, no `&`/`xargs -P`).
- `folder_bridge_search_files` stops early on big shares; point it at the
  narrowest folder you can and treat "no match" as "not found yet".
- The total number of files on a big share is unknown. The Test button's
  "at least N files (stopped counting after 20 s)" is a lower bound; don't
  try to count them yourself.

An error such as `VPN connect failed: …`, `File share login failed …` or
`… overlaps this server's network …` means the folder or VPN settings need
fixing in Files → Bridge or Settings → In&Out; tell the user, don't retry.

## Commands

```
hermes vpn list                 # every configured VPN: name, state, mount path
hermes vpn status ["<name>"]    # one VPN, with the last file-share check
hermes vpn up "<name>"          # connect (if the VPN allows agents to connect)
hermes vpn test "<name>"        # connect if needed, then list the share
hermes vpn down "<name>"        # disconnect and unmount
```

Add `--json` for machine-readable output. Each command prints one line, e.g.

```
Office files: connected — files at /opt/data/vpn-files/office-files (read-only)
Office files: error — Login failed: wrong username or password
```

`up` and `test` exit non-zero when the VPN is not connected afterwards.

## Workflow (older VPNs with their own share)

For network folders, use the Folder Bridge tools above. For an older VPN that
still has its own share:

1. `hermes vpn list` to find the VPN name (quote names with spaces).
2. `hermes vpn up "<name>"`. If the line says `connected`, the files are under
   the printed mount path.
3. Map the user's path onto the mount: `\\fileserver01\Shared\Reports\Q3.xlsx`
   with share `//fileserver01/Shared` becomes
   `/opt/data/vpn-files/<slug>/Reports/Q3.xlsx`. List that one folder first
   when unsure of the exact name; the "one folder at a time" rules above
   apply here too.
4. Read what you need. Copy a file to your workspace if you have to convert or
   edit it; never try to write to the mount (it is read-only by design).
5. `hermes vpn down "<name>"` when you are finished. If you forget, it
   disconnects itself after the configured idle time (default 30 minutes).

## Rules

- Never try to read, print or guess the VPN or file-share password. They are
  not available to your terminal, and searching credential stores, `/run`,
  `/etc` or process lists for them is off limits.
- Don't add routes, edit network settings, or run `openfortivpn`, `mount` or
  `sudo` yourself. `hermes vpn` is the only supported way in.
- Don't connect a VPN that the task doesn't need.

## When something goes wrong

Tell the user plainly what happened, and what they can do in
Settings → In&Out. Don't keep retrying.

| Output | Tell the user |
|---|---|
| `Connect '<name>' in Settings → In&Out, then tell me.` | This VPN is set so only the user can connect it. Ask them to connect it, then continue. |
| `needs_cert — … certificate is not trusted yet` | The VPN server's certificate needs their approval. Ask them to review and trust it in Settings → In&Out. |
| `error — Login failed: wrong username or password` | The saved VPN login was rejected; they should update it in Settings → In&Out. |
| `error — … one-time code (FortiToken) …` | This VPN needs a FortiToken code, which Hermes can't enter yet. |
| `error — Can't reach the VPN server …` / `Can't find the VPN server …` | The VPN server is offline or the address is wrong. |
| `error — File share login failed …` / `Share … was not found` | The VPN works but the file-share login or path is wrong; they can fix it in the network folder's settings in Files → Bridge. |
| `… missing the kernel's UTF-8 file name support …` | The server needs an operator fix (a kernel package); the user can't fix it in the UI. |
| `File server is too slow to answer …` | The file server or VPN link is overloaded; wait and try one folder later, don't retry in a loop. |
| `error — VPN support is not installed on this server …` | VPN support hasn't been set up on this server yet; the operator must install it. |
| `No VPNs are configured.` | Ask the user to add the VPN in Settings → In&Out. |
