# Install test (fresh Hetzner VM)

`.github/workflows/install-test.yml` checks that `install-aquarium.sh` still installs
Aquarium on a brand-new Ubuntu 24.04 server, the way a customer would run it.

## What one run does

1. (Release-candidate tags only) waits for the signed release, see step 2.
   Then creates a throwaway Hetzner VM (`cx33`, `nbg1`, Ubuntu 24.04) and a one-off SSH key,
   both named `aq-install-test-<run id>-<attempt>` and labelled `purpose=aquarium-install-test`.
2. On the VM, runs the installer exactly like the README command:
   `curl -fsSL https://raw.githubusercontent.com/leolau/aquarium/<ref>/install-aquarium.sh | bash -s -- <mode>`.
   `<mode>` is `--version <ref>` when `<ref>` is a tag with a published GitHub release
   (the signed release a customer gets), otherwise `--from-branch <ref>` (a development
   install of that branch or tag). On a release-candidate tag push the workflow first
   waits (up to 75 min) for `release.yml` to publish that tag's signed release, and fails
   if the release run fails, so it always tests the real download.
   With TLS on, it uses `<vm-ip-with-dashes>.sslip.io` (app) and
   `dash.<vm-ip-with-dashes>.sslip.io` (dashboard), so Caddy gets real Let's Encrypt certificates.
3. The installer's own health checks must pass (it exits non-zero on any `FAIL`).
   Then the workflow also checks:
   - a first owner exists, and `admin` can sign in to agent-home (`/api/session/login`)
     with the generated password (skipped when the install hands out a one-time
     setup link instead of a password) while a wrong password gets 401;
   - no service logged the duplicate pgvector error (`pg_extension_name_index`);
   - ufw is on, and from the internet none of the internal ports
     (3100, 5432, 6543, 8000, 8443, 8791, 9119, 9220, 9221) answer;
   - with TLS: `https://<app domain>/login` and `https://<dashboard domain>/` work.
4. Always deletes the VM and the SSH key, even when an earlier step failed or the run
   was cancelled. If the delete fails, the job fails with the server name so you can
   remove it in the Hetzner console.

Not covered yet: upgrading from the previous release (no releases exist yet); signing
in through the browser; chatting with a real model (no model key is installed).

## When it runs

- By hand: GitHub → Actions → "Install test (fresh Hetzner VM)" → Run workflow.
  Options: `ref` (branch/tag, default = the branch you start it from), `tls`,
  `skip_embed_model` (faster, skips the 2.3 GB model and the embedding check).
- Automatically when a release-candidate tag like `v1.0.0-rc.1` is pushed.

A run takes about 25–35 minutes (plus the wait for `release.yml` on tags) and costs a few cents (cx33 is billed hourly).

## One-time setup: the `HCLOUD_TOKEN` secret

The workflow needs a Hetzner Cloud API token. It is not created automatically.

1. Hetzner Cloud console → pick the project for test servers (ideally a separate
   project from production, so a test token can never touch the production server)
   → Security → API tokens → Generate API token, permission **Read & Write**.
2. GitHub → leolau/aquarium → Settings → Secrets and variables → Actions →
   New repository secret, name `HCLOUD_TOKEN`, paste the token.

Without the secret the workflow stops at its first step with a clear error and creates nothing.

## Cleaning up by hand

If a runner is killed hard (so even the delete step could not run), find leftovers with:

```bash
hcloud server list -l purpose=aquarium-install-test
hcloud ssh-key list -l purpose=aquarium-install-test
```

and delete them with `hcloud server delete <name>` / `hcloud ssh-key delete <name>`.
