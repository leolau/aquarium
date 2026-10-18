# WhatsApp bridge controls + Settings scope display

Status: deployed 2026-09-24 (316b3d54c, PR #439)

- Sudoers entry for `wa-bridge-add.sh` added to `/etc/sudoers.d/hermes-agent`
  (visudo-validated) — add-bridge provisioning works.
- `wa-bridge-personal` rebound post-deploy: old logged-out session moved to
  `session-personal.rebind-*`, fresh `qr.txt` emitted — awaiting a phone scan
  via Settings → WhatsApp bridges → Show QR.
- Verified on box: `/api/wa-bridges` mounted (401 unauthenticated), 7/7
  pytest, agent-home rebuilt, all units active.

## Scope

Two asks bundled:

1. **Settings shows granted OAuth scopes, not just service flags.** The
   Connected accounts checkboxes only reflected the `services` flags — an
   account restored from a legacy token showed "Email" ticked while the grant
   lacked `mail.google.com`. Now each google entry compares
   `payload.scopes` (survives redaction) against a mirror of
   `SCOPES_BY_SERVICE`; a flagged-but-ungranted service shows
   "(not granted)", and an expandable row lists the raw granted scopes.

2. **WhatsApp bridge management in Settings.** New `WhatsAppBridges`
   section: list all `hermes-wa-bridge-*` units with live status
   (active/activating/failed, paired, QR pending/stale), per-bridge
   **Restart / Stop / Rebind / Show QR**, and an **Add bridge** form.
   Rebind moves the session dir aside (timestamped backup, not delete) and
   restarts so Baileys emits a fresh QR. The QR panel auto-refreshes every
   20s while open (payload rotates ~60s); the raw pairing payload is
   rendered to SVG in the BFF route — it never reaches client JS.

## Pieces

| Layer | Change |
|---|---|
| `hermes_cli/wa_bridge_api.py` | Owner-gated router `/api/wa-bridges`: GET list, GET `/{name}/qr`, POST `/{name}/restart|stop|rebind`, POST add. Service control via `sudo -n systemctl` (existing grant). Discovery = unit files + `session-*` dirs. |
| `deploy/wa-bridge-add.sh` | Root provisioning helper: writes unit + unprivileged drop-in, creates session dir (hermes-owned), picks next free port ≥3000, enables + starts. |
| `web_server.py` | Mount the router. |
| agent-home | `WaBridge` type, client methods, BFF routes (`wa-bridges`, `wa-bridges/[name]`, `wa-bridges/[name]/qr`), `WhatsAppBridges` component, `qrcode` dep for SVG rendering. |
| ConnectedAccounts | Granted-scope markers + expandable scope list. |

## Deploy-time requirements (box)

1. Pull develop (deploy-hermes.sh).
2. Add sudoers line so `add bridge` works:
   superseded (security review F14: the hermes user can edit the checkout, so
   this rule gave it root): the helper is now `deploy/hermes-wa-bridge-add`,
   installed root-owned at `/usr/local/sbin/hermes-wa-bridge-add`, rule in
   `deploy/sudoers.d/hermes-wa-bridge`.
   in `/etc/sudoers.d/hermes-agent`.
3. No restart needed beyond the dashboard service for the new router.

## Known live state (2026-09-24)

- `wa-bridge-personal`: logged-out session, crash-loops — needs Rebind + QR scan.
- `wa-bridge-connectar`: active, but a `qr.txt` is pending — may also be
  mid-repair; check QR age in the UI.
- Credential store holds only the 3 accounts restored from legacy files
  (calendar/drive/workspace scopes — no `mail.google.com`); the user's
  re-consent attempts never reached the backend (no pending-state files,
  no new rows). All 4 accounts need a fresh Connect run.
