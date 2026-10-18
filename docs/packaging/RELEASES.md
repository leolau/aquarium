# Aquarium releases: what gets published and how to verify it

This is the contract between the release pipeline
(`.github/workflows/release.yml` + `scripts/build-release.sh`) and anything
that downloads a release: `install-aquarium.sh` and `aquarium update`.

## 1. How a release is made

1. Leo pushes a tag on the commit to release:
   `git tag v1.2.0 && git push origin v1.2.0`.
2. GitHub Actions (`Release` workflow) runs the Python test suite and the
   agent-home typecheck, lint and tests. If any fail, nothing is published.
3. It runs `scripts/build-release.sh <tag>`, signs `SHA256SUMS`, verifies the
   signature exactly like the installer will, and publishes a GitHub Release.

Tag names:

| Tag | Channel | GitHub release |
|---|---|---|
| `vX.Y.Z` (e.g. `v1.2.0`) | `stable` | normal release; "Latest" if it is the newest stable |
| `vX.Y.Z-rc.N` (e.g. `v1.3.0-rc.1`) | `beta` | prerelease |
| `vX.Y.Z-beta.N` | `beta` | prerelease |

Anything else (e.g. upstream Hermes CalVer `v2026.5.15`) does not start the
workflow. Order: `v1.3.0-beta.1 < v1.3.0-rc.1 < v1.3.0`.

## 2. Assets on every release

| Asset | What it is |
|---|---|
| `aquarium-vX.Y.Z-linux-x86_64.tar.gz` | the release; unpacks to one folder `aquarium-vX.Y.Z/` |
| `SHA256SUMS` | `sha256sum` line for the tarball |
| `SHA256SUMS.sig` | cosign keyless signature over `SHA256SUMS` (base64) |
| `SHA256SUMS.pem` | the short-lived signing certificate (Fulcio) for that signature |
| `SHA256SUMS.cosign.bundle` | the same signature + certificate + transparency-log entry in one file (optional, for offline checks) |
| `channels.json` | which version each channel points at (section 4) |

Download URL: `https://github.com/leolau/aquarium/releases/download/<tag>/<asset>`.

## 3. Verifying (installer and `aquarium update` must do both steps)

```bash
TAG=v1.2.0
cosign verify-blob \
  --certificate SHA256SUMS.pem --signature SHA256SUMS.sig \
  --certificate-identity "https://github.com/leolau/aquarium/.github/workflows/release.yml@refs/tags/$TAG" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  SHA256SUMS
sha256sum -c SHA256SUMS
```

- What this proves: `SHA256SUMS` was signed by **this repo's `release.yml`
  running for exactly this tag**, and the tarball matches it. Nobody holds a
  signing key (keyless: GitHub gives the workflow a one-time identity token,
  Sigstore turns it into a 10-minute certificate, and the signature is logged
  in the public Rekor log). There is no key to leak or rotate.
- Use the exact identity with the tag you are installing (not a regex). That
  stops someone from passing off an older signed release as a newer one.
- Needs cosign v2 on the box (the pipeline signs with cosign v2.6.5). The
  installer should download a pinned cosign binary and check its sha256
  before use.
- If the repo is ever renamed or moved, the identity string changes; releases
  signed before the move keep the old name.
- Alternative with the bundle: `cosign verify-blob --bundle SHA256SUMS.cosign.bundle --certificate-identity ... --certificate-oidc-issuer ... SHA256SUMS`.

## 4. Channels (`stable` / `beta`)

`channels.json`, attached to every release:

```json
{
  "schema": 1,
  "repo": "leolau/aquarium",
  "generated_at": "2026-10-18T08:00:00Z",
  "channels": {
    "stable": {"version": "v1.2.0", "tarball": "aquarium-v1.2.0-linux-x86_64.tar.gz",
               "download_base": "https://github.com/leolau/aquarium/releases/download/v1.2.0/"},
    "beta":   {"version": "v1.3.0-rc.1", "tarball": "aquarium-v1.3.0-rc.1-linux-x86_64.tar.gz",
               "download_base": "https://github.com/leolau/aquarium/releases/download/v1.3.0-rc.1/"}
  }
}
```

- `stable` = newest `vX.Y.Z`; `null` until the first stable release exists.
- `beta` = newest release of any kind (if a stable is newer than every rc,
  beta users get that stable).
- Fixed URL for the current file:
  `https://github.com/leolau/aquarium/releases/latest/download/channels.json`
  (the workflow re-uploads it to the newest stable release after each beta).
  Before the first stable release this URL returns 404; fall back to the API.
- API fallback (same answer): stable = `GET /repos/leolau/aquarium/releases/latest`
  (GitHub excludes prereleases); beta = newest entry of
  `GET /repos/leolau/aquarium/releases` that is not a draft.
- `channels.json` is not signed. It only picks a version; the tarball for that
  version must still pass section 3 with that version's tag.

## 5. What is inside the tarball

`aquarium-vX.Y.Z/` holds the repo at the tagged commit (committed files only)
**without** `tests/`, `website/`, `.github/`, `plans/`, `.plans/`,
`infographic/`, `agent-home/test/`, plus prebuilt parts so the customer box
never runs `npm` or `next build`:

| Path | What |
|---|---|
| `VERSION` | the tag, e.g. `v1.2.0` |
| `RELEASE.json` | version, channel, commit SHA, build time, paths below |
| `hermes_cli/web_dist/` | dashboard bundle (served by `hermes dashboard --skip-build`) |
| `agent-home/standalone/` | agent-home Next.js standalone server, including its own `node_modules`, `.next/static` and `public` |

Run agent-home from a release (needs only `node` 22, no npm):

```bash
cd aquarium-vX.Y.Z/agent-home/standalone/agent-home
HOSTNAME=127.0.0.1 PORT=3100 node server.js   # plus the agent-home.env variables
```

Not bundled: the Python venv (the installer runs
`uv sync --locked` / `uv pip install` from `pyproject.toml` + `uv.lock` on the
box), the WhatsApp bridge `node_modules` (`scripts/whatsapp-bridge`, installed
with `npm ci --omit=dev` there), Supabase.

The tarball is reproducible: file times come from the commit time and owners
are 0/0, so building the same tag twice gives the same bytes when npm resolves
the same lockfile.

## 6. Building one locally

```bash
npm ci   # not needed; the script builds in its own clean copy
scripts/build-release.sh v1.2.0-rc.1 --out dist      # builds HEAD
scripts/build-release.sh v1.2.0 --ref v1.2.0 --out dist
tar -tzf dist/aquarium-v1.2.0-rc.1-linux-x86_64.tar.gz | head
```

Needs git, node 22 + npm, python3, GNU tar, gzip, sha256sum. Takes a few
minutes (npm ci + two Next builds). Local builds are not signed.

## 7. GitHub settings this needs

- Actions must actually run on this repo (it is a fork of
  NousResearch/hermes-agent; see the PR that enabled CI).
- Settings → Actions → General → Workflow permissions can stay "Read": the
  workflow asks for `contents: write` (publish job) and `id-token: write`
  (signing job) itself.
- If a tag ruleset is added later, allow Leo to create `v*` tags.
