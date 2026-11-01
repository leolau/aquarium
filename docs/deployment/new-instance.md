# New Aquarium instance (from a git clone)

One server = one organization. On a fresh **Ubuntu 24.04, x86_64** server with
8 GB+ RAM and 25 GB+ free disk:

```bash
git clone https://github.com/leolau/aquarium.git && cd aquarium
./install-aquarium.sh --check     # read-only: OS, CPU, memory, disk, ports 80/443, DNS
sudo ./install-aquarium.sh        # installs this clone; asks for the settings below once
```

Run from a clone, the installer installs **that clone** (`--from-checkout`): it is
copied to `$AQUARIUM_ROOT/hermes-agent` (default `/opt/data/hermes-agent`) with its
`.git`, so nothing is re-cloned or downloaded from GitHub Releases. Installing from a
clone is not signature-verified; for a signed release use `--version vX.Y.Z`.

## Instance settings

Asked for once (in a terminal), validated, then saved in `/etc/aquarium/aquarium.conf`.
Re-runs read that file and ask nothing, so `sudo ./install-aquarium.sh` is safe to repeat.

| Setting | Option | Environment | Default |
|---|---|---|---|
| Organization name | `--org-name` | `AQUARIUM_ORG_NAME` | `Aquarium` |
| App host name (agent-home) | `--home-domain` | `AQUARIUM_HOME_DOMAIN` | none: no HTTPS, local only |
| Dashboard host name | `--dashboard-domain` | `AQUARIUM_DASHBOARD_DOMAIN` | none |
| Owner login | `--owner-id` | `AQUARIUM_OWNER_ID` | `admin` |
| Owner email (Let's Encrypt contact) | `--owner-email` | `AQUARIUM_OWNER_EMAIL` | none |

Order of precedence: option, environment, saved file, prompt, default. `--yes` never
prompts (for automation):

```bash
sudo ./install-aquarium.sh --yes --org-name "Example Org" \
  --home-domain aquarium.example.org --dashboard-domain admin.example.org \
  --owner-email it@example.org
```

Before installing with domains, point an A record for each at the server. The preflight
warns when a name does not resolve (or resolves elsewhere) and fails when another program
holds port 80 or 443, which Caddy needs for the certificates. To change a setting later,
edit `/etc/aquarium/aquarium.conf` (or pass the option) and re-run the installer.

## After the install

The installer ends with:

- **Owner setup link**: one-time, valid 24 hours; sets the owner's email and password.
  The printed command creates a new one.
- **Secrets**: `/opt/data/aquarium-secrets.env` and `/etc/aquarium/*.env`, root only.
  Nothing secret is in `aquarium.conf` or the clone.
- **Models**: add provider API keys (e.g. `OPENROUTER_API_KEY=...`) to
  `/opt/data/hermes-home/.env`, then `sudo systemctl restart hermes-gateway hermes-dashboard`.
- **Health / logs**: `sudo aquarium doctor`, `sudo aquarium logs [service]`.

## Updating

```bash
sudo /opt/data/hermes-agent/scripts/aquarium-update.sh [BRANCH]
```

Fetches `BRANCH` (default: the branch that was installed) from the clone's `origin`,
refuses to overwrite local edits, rebuilds what changed, restarts the services and checks
them (it runs `/opt/data/deploy-hermes.sh`). On a release install the same script hands
over to `sudo aquarium update`. Alternatively, `git pull` in your own clone and re-run
`sudo ./install-aquarium.sh`, which copies the updated clone and rebuilds.
