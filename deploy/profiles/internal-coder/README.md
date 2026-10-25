# Coder profiles (FG-33 §10, decision 15)

`deploy/profiles/internal-coder/` and `deploy/profiles/external-coder/` are the
versioned definitions of the two Hermes profiles that build vibe-coded apps.
Each has:

- `profile.yaml`: name, semver `version`, description and the repo skills
  (paths under `skills/`) copied into the profile.
- `config.yaml`: an overlay deep-merged onto the profile's own `config.yaml`
  (overlay keys win, every other key is kept).
- `SOUL.md`: the profile's identity, replaced on every install.

The profiles only run as kanban workers (`hermes -p <name> chat -q`, spawned
by the dispatcher). Neither gets a channel or gateway, so the overlay may not
set `platforms`, `gateway` or `mcp_servers`.

`hermes_cli.app_coder.coder_profile_for(tool)` returns the tool's
`coder_profile` if set, otherwise `internal-coder` (local) or `external-coder`
(external); the build cards are assigned to it.
`hermes tool set <slug> --coder-profile <name>` overrides it (owner/admin for
shared tools, the author for private ones; the profile must exist).

## Credentials

A coder profile never holds a credential. Hosting-provider credentials stay
`materialize=False` behind the adapters (FG-33 §4.2) and the LLM provider
comes from the box's normal setup, so nothing secret is written here or by
the installer. `python -m hermes_cli.app_coder check` refuses a definition
with a secret-looking key, and `install` refuses a profile whose `.env` holds
a hosting-provider credential (`VERCEL_*`, `RAILWAY_*`, `AWS_*`,
`ALIBABA_*`, `SUPABASE_*`, `GITHUB_*`/`GH_*`, ...). Remove the variable, do
not work around the check.

## Install (ops step, system-test box first)

As the `hermes` user, from the deployed checkout:

```bash
python -m hermes_cli.app_coder check            # validate both definitions
python -m hermes_cli.app_coder install          # create/update both profiles
hermes profile list                             # internal-coder, external-coder
```

`install` is `hermes profile create <name> --no-alias` (when the profile is
missing) plus the overlay, `SOUL.md` and skills. It never touches `.env`,
`auth.json`, memories or sessions, and is safe to re-run after an upgrade: the
installed version is in `<profile>/coder-profile.yaml`. Skills listed but not
yet in the checkout are reported and skipped; re-run once they land.

Bump `version` in `profile.yaml` whenever a definition changes.
