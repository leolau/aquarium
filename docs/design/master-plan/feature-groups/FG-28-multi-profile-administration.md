# FG-28 — Multi-profile administration (one admin, several profiles)

**Wave:** P6-C (Phase-6 follow-on — after FG-26; requires FG-27 Layers 3+1). **Also carries the one-gateway-for-all-profiles consolidation.** · **Owner agent:** _unassigned_ · **Status:** IN PROGRESS — backend chokepoint built (#225, #227/#229); re-reviewed 2026-11-01: two security fixes, login/activation across profiles, the admin switcher/picker, secret isolation and real-Postgres tests are open — see §"Revised plan (2026-11-01)"

## Revised plan (2026-11-01) — re-reviewed against `develop` `f4a7cda8a`

> **Read this section first.** Every claim below was re-checked against the code
> at `f4a7cda8a` by three parallel reviews (login/identity/activation; console
> scope and admin UI; secrets, account verbs, audit and tests). Where an older
> section of this doc disagrees, this section wins; the older sections are kept
> as history and carry correction notes. **Nothing in the FG-28 code paths has
> changed since 2026-08-14** — the backend chokepoint is as shipped, and every
> open item below is still open.

### What is built (verified)

- **Profile registry** (`hermes_cli/profile_registry.py`, `hermes profile registry list|health`) — derived view, no authority data. No HTTP endpoint.
- **Console chokepoint** `require_console_scope` (`web_server.py`) → `console_scope._scoped_to` → `agent.profile_runtime.profile_runtime_scope`, held for the whole handler. Declared by **15** routes, all `/api/comms/{whoami,members*,directory}`.
- **Principal re-derived in the target, no owner fallback** — `resolve_console_principal` / `_comms_console_actor`: no subject 401, not enrolled 403, suspended 403. Structural route-table test (`tests/hermes_cli/test_fg28_console_routes.py`) passes.
- **`guard_account_level_op` / `enrolled_profiles` / `administered_profiles`** (`console_scope.py`) — written and unit-tested; the guard has **no production caller**.
- **Scoped admin credentials** — only `members.py` `_resolve_url` / `_resolve_service_role_key` read through `get_secret`.

### Two security findings (fix before any FG-28 UI)

1. **An admin-minted link resets a box-wide password.** `POST /api/comms/members/{user_id}/invitation` → `MemberService.issue_invitation` is gated only by `require_member_admin`, works for **any** enrolled principal (already active or not, any role), and returns the **raw token to the admin**. Redeeming it calls `activate_with_password` — a box-wide GoTrue password set **plus ban lift**. So an `hr` admin can set the password of an account also enrolled in `engineers` and sign in as that person there (INFERRED from code; not exercised live). Within one profile the same path lets an admin take over another admin's or the owner's account. This is the escalation `guard_account_level_op` exists for; §"Re-read against the shipped code, 2026-08-13" below was wrong to call `set_password` holder-only.
2. **The chat profile picker is a grant.** agent-home's chat `ProfilePicker` lists every profile from unauthenticated `GET /api/profiles`. `session_chat` / `session_chat_stream` resolve the principal in the **acting (default)** profile *before* reading `profile`, then run the turn — that profile's brain, config and credentials — inside `_chat_turn_profile_scope(profile)`. A default-profile member can therefore chat as any profile they are not enrolled in, and a default owner sees every profile's conversations.

### Gaps the original plan did not cover

- **Login lands only in the default profile.** agent-home login calls `whoami` with no `?profile=`; a person enrolled only in a named profile passes the password check and gets 409 `no_principal`. The session cookie carries no profile, and `principal.role` is the default profile's role — so the BFF's `requireMemberAdmin` 403s an `hr` admin who is only a member in default before Python's scoped check runs.
- **The BFF never sends `?profile=` on member routes**, so the cross-profile console is unreachable from agent-home even though Python accepts it; body `profile=hr` without `?profile` is a 409.
- **Everything outside `/api/comms/{members,directory,whoami}` is acting-profile only**: 15 more `/api/comms` routes, 21 other `web_server.py` routes, 14 router modules and 140 `_ADMIN` routes resolve through the legacy resolver or the dashboard token.
- **2FA and `/api/account/*` resolve the person in the default profile**; someone not enrolled there skips 2FA and cannot manage it.
- **Password-reset requests** require a principal in the acting profile and silently do nothing for a named-profile-only user.
- **Fail-closed secrets are unarmed in the dashboard process** (`set_multiplex_active` is called only by the gateway) even though the dashboard already serves several profiles per request (`require_console_scope`, `_chat_turn_profile_scope`, `_profile_scope`).
- **Audit** lands in the target profile's ledger by construction (INFERRED), but the payload does not name the acting/target profile and no test asserts placement.

### Decisions needed from Leo

| # | Decision | Recommendation |
|---|---|---|
| D1 | Login for someone not enrolled in `default` | Land them in an enrolled profile (hint → default → only → first), not "enrol everyone in default as Viewer" |
| D2 | Supabase URL / service-role / JWT keys: box-wide or per profile | Box-wide (one GoTrue): add them to `secret_scope._GLOBAL_ENV_EXACT` |
| D3 | Chatting in a profile requires enrolment there; owner visibility from the *target* profile | Yes |
| D4 | May an admin mint a link for an account that has already signed in? | No — first activation only; a signed-in person uses self-service reset. Never for a higher-ranked target |

### Revised implementation order

Each row is about one PR. Phase A is standalone and ships first.

| # | Step | Where (existing seams) | Tests | Effort | Needs |
|---|---|---|---|---|---|
| **A1** | Close the invitation hole: `issue_invitation` refuses an already-activated account (D4) and any target outside the actor's administered profiles via `guard_account_level_op`; never a higher-ranked target; `redeem_invitation` refuses `kind="activation"` for an account that has signed in; `AccountLevelPermissionError` → 403 | `hermes_cli/members.py`, `hermes_cli/console_scope.py` (store-factory helper), `web_server.py` `_comms_member_error` | `test_members.py`; structural test in `test_fg28_console_routes.py`: any route reaching `activate_with_password` / `set_password` / `set_banned` / `delete_user` calls the guard or is on a self-service allowlist (`/api/account/password`, `/api/auth/invitations/*`) | 1 d | D4 |
| **A2** | Chat authority: read `profile` first, resolve the principal **in that profile** (`_chat_principal`), apply to `_chat_scope` and every chat read route; `GET /api/chat/profiles` lists only active enrolments; `GET /api/profiles` requires auth | `web_server.py` `session_chat`, `session_chat_stream`, attach/cancel, `_chat_scope`; `agent-home/src/app/api/chat/profiles/route.ts` | `test_web_server_session_chat.py` with real temp profile homes (pattern: `test_fg26_profile_scope_e2e.py`): not enrolled → 403; enrolled → target role; default owner ≠ hr owner | 1–1.5 d | D3 |
| B1 | `console_scope.enrolments(subject)` → `[(entry, principal)]`; `enrolled_profiles` / `administered_profiles` become wrappers. One endpoint `GET /api/auth/my-profiles` → `[{name, role, active, is_default, health?}]`, subject required, no owner fallback, not under `require_console_scope`. Feeds both the login chooser and the admin switcher | `console_scope.py`, `web_server.py`, `agent-home/src/lib/api/client.ts` | `test_fg28_console_scope.py`; route-auth table; no subject → 401 | 0.5 d | — |
| B2 | Login lands in a profile; cookie gains `profile` (old cookies read as `default`); signed last-profile hint cookie; `LoginForm` messages for `no_principal` / `suspended` | `agent-home/src/app/api/session/login/route.ts`, `lib/auth/principal.ts`, `lib/auth/session.ts`, `components/LoginForm.tsx` | `login/route.test.ts`: hr-only → 200 with `profile=hr`; hint honoured only when enrolled; all suspended → 403 | 1 d | B1, D1 |
| B3 | Session profile everywhere: `apiClientForRequest()` defaults to `session.profile`; `POST /api/session/profile` re-runs `whoami?profile=` and rewrites the cookie only on 200; header switcher replaces the chat-only picker; non-chat pages gated to `default` until B4 | `lib/auth/principal.ts`, new `app/api/session/profile/route.ts`, `components/chat/ProfilePicker.tsx` → header switcher, `app/chat/page.tsx` | switch to an unenrolled profile → 403, cookie unchanged | 1–1.5 d | B2 |
| B4 | Profile-aware legacy resolver: `_comms_resolve_principal`, `route_roles.role_dependency` and `_account_login` enter the named profile and refuse owner fallback when a subject is present; each remaining `/api/comms` route and router module either honours `?profile=` or rejects it. `HermesApiClient.scopedPath` becomes opt-in per method | `web_server.py`, `hermes_cli/route_roles.py`, router modules, `agent-home/src/lib/api/client.ts` | extend the structural test: `GET /api/comms/goals?profile=hr` is scoped or refused, never served from the acting profile | 1.5–2 d | B3 |
| B5 | 2FA and user prefs are account-level at the box root (keyed by GoTrue subject, never `""` for an authenticated subject) | `hermes_cli/two_factor.py`, `dashboard_auth/routes.py`, user-prefs callers | hr-only user with 2FA must enter a code; scoped request writes to the root | 0.5–1 d | B4 |
| C1 | Profile-aware BFF for `/api/comms/members*` and `/directory`: bind `apiClientForRequest({profile})`, gate on `whoami?profile=` instead of the session role | `agent-home/src/lib/api/member-bff.ts`, `app/api/comms/members/**`, shared `lib/profile.ts` | BFF forwards `?profile`; default-member/hr-admin is not 403'd by the BFF | 1 d | B1 |
| C2 | Activation and recovery links carry the profile: `/activate/<profile>/<token>` (legacy `/activate/<token>` = default); new tokens hash-bound to the profile (`hash("v2:"+profile+":"+token)`); redeem/request validate against the registry and run inside `_scoped_to`; reset request mints where the person is enrolled; same neutral 400 for every failure | `hermes_cli/invitations.py`, `members.py`, `web_server.py` `auth_redeem_invitation`, `auth_request_invitation`, `comms_issue_invitation`; agent-home `app/activate/[profile]/[token]`, `ActivateForm`, redeem/request BFF routes | `test_fg26_invitations_e2e.py`: hr link redeems; tampered profile → neutral 400; v1 links still work | 1.5 d | D2, A1 |
| C3 | Admin switcher on the Users screen (`?profile=` in the URL, validated against B1, hidden with < 2 administered profiles) | new `components/users/AdminProfileSwitcher.tsx`, `UsersView.tsx`, `app/users/page.tsx`, member components via `withProfileQuery` | `UsersView.test.tsx`, `AdminProfileSwitcher.test.tsx` | 1 d | C1 |
| C4 | Create-user and CSV-import picker over administered profiles; body `profile` must equal `?profile=` | `CreateUserForm.tsx`, `CsvImportPanel.tsx`, `comms_create_member` / `comms_import_members` | picker is not a grant: `?profile=hr` by an hr member → 403 | 0.5–1 d | C2, C3 |
| D-1 | Box-wide Supabase keys (D2) in `_GLOBAL_ENV_EXACT`; arm fail-closed in the dashboard when the registry serves > 1 profile (config.yaml, not an env var); migrate remaining console-reachable `os.environ` reads (`_llm_tag_suggest`, ElevenLabs, `EMAIL_CONFIG_PATH`) | `agent/secret_scope.py`, `web_server.py` startup, `hermes_cli/config.py`, `email_accounts_api.py` | `test_fg28_member_credentials.py`, `test_secret_scope.py` | 1 d | D2 |
| D-2 | Audit payload names acting and target profile; real-Postgres negative matrix (CFO/CTO/shared-member over `hr`/`engineers`/`testers`) and two-profiles-one-process secret isolation, reusing the Docker fixture lifted out of `test_fg26_profile_scope_e2e.py` | `identity_audit.py`, `members.py`; new `tests/hermes_cli/test_fg28_console_matrix_e2e.py`, `test_fg28_secret_isolation_e2e.py` | itself (write red first) | 2 d | A1–C4 |
| D-3 | System test on the current production box via the private runbook (`PRODUCTION.md` in `leolau/aquarium-ops`), or the Docker e2e above as the gate; `scripts/fg28_systest.py` docstring updated | — | — | 0.5 d | all |

Total ≈ 14–17 engineer-days (about 3 Devin sessions). A1 and A2 are each a
standalone security PR.

## Reframing (2026-08-10) — this is the console over the goal tree

The domain model changed after this FG was written, and it changes what the FG
*is* more than what it builds.

A **profile is not a tenant and not a cohort of people** — it is the *instrument
for one sub-goal*, carrying the behaviour that sub-goal needs (FG-29). **People
participate in as many profiles as their work spans**, holding a `principals`
row in each under one shared GoTrue subject, with separate memory in each.

Three consequences:

1. **The "users belong to exactly one profile" constraint below was imported,
   not imposed.** The same person can already hold rows in `finance` and
   `product`. What is per-profile is their *data*, which is the isolation we
   want. A CTO who works on cashflow and product quality is one login and two
   working memories — no groups, no cross-profile identity work.
2. **This is no longer "administration spanning tenants."** It is one console
   over the entity's goal tree: the owner sees the whole tree, and each person
   sees the participations they hold. Administration is a consequence of that
   view, not its purpose.
3. **It is also a runtime consolidation**, not only a UI — see "One gateway for
   all profiles" below, which removes the per-profile daemon cost.

The authority model, the routing, the owner-fallback hazard and the account-vs-
enrolment split below are all unchanged by the reframing. Read them as written;
only the *motivation* section above is superseded.

## Summary

The owner runs several profiles — `engineers`, `testers`, `hr`. Each is an
isolated brain with its own users, memory and database. The requirement is that
**one administrator can create and manage users in several of them**, and that
the owner can choose which:

```
profiles:   engineers      testers        hr
admins:     CTO ───────────CTO            CFO
users:      Adam           Mary           John
```

CTO administers `engineers` and `testers`; CFO administers `hr`; neither can
touch the other's. Adam, Mary and John each remain in **exactly one** profile.

**This is not cross-profile identity for users.** Nothing a user can read or
write crosses a profile boundary; the brains, memories and databases stay as
isolated as they are today. The only thing that crosses is *administration*.

That distinction is the whole design. It is also what makes the feature
defensible against the repo's standing rule that profiles are independent
islands: we are not coupling the *runtimes*, we are adding a control plane above
them.

## Why this needs its own FG (and an explicit decision)

`AGENTS.md` records profile independence as deliberate, and cites a closed PR
that added cross-profile config inheritance: *"coupling profiles together is
exactly what the design prevents."* FG-28 moves in the opposite direction from
FG-27, which **strengthens** the boundary. So it must be argued, not assumed.

The argument for doing it anyway: today the boundary is enforced by *physical
separation* (separate processes, separate consoles, separate URLs). An operator
with three profiles either logs into three consoles or, far more likely, gives
one person the owner credential for all three — which is strictly worse than a
scoped console. **FG-28 replaces an informal boundary that people route around
with a formal one the code enforces.** But it does move the boundary from "two
processes cannot see each other" to "one service must get this right", and that
is a real increase in the consequences of a bug.

## What already exists (this is cheaper than it looks)

Four pieces of the mechanism are already in the tree.

**1. The entitlement model needs no new tables.** The Supabase dashboard-auth
provider verifies GoTrue's access token and uses the `sub` claim as the
identity; `hermes_cli/access.py` uses that same UUID as `principal.user_id`.
**All profiles share one Supabase instance (decided 2026-08-10)**, therefore one
GoTrue, so one login produces one subject that is meaningful in every profile — and each profile's own `principals` table decides
whether that subject is enrolled and with what role:

```
CTO has an `admin` principal row in engineers   → may administer engineers
CTO has an `admin` principal row in testers     → may administer testers
CTO has NO row in hr                            → may not administer hr
```

"Assign a profile to an admin" is therefore just `hermes member add` in that
profile. **The existing per-profile `principals` table *is* the entitlement
list**, it is already RLS-protected, and it fails closed by construction —
absence of a row is absence of authority. No new authority model, no new role
type, nothing to keep in sync.

**2. The fail-closed behaviour is already implemented.** `_comms_resolve_principal`
raises **409** for a subject that authenticates but is not enrolled — it is
explicitly documented as "never silently upgraded to the owner". CFO's request
against `hr` is already rejected by the code path a console would reuse.

**3. Per-request profile scoping already exists.** `set_hermes_home_override()`
is a `contextvar`, `get_hermes_home()` honours it, and `load_config()` caches on
the *config path* so a profile switch cannot collide. With FG-27 Layer 3, the
schema derives from `get_active_profile_name()`, which reads the same
contextvar. So scoping a request to a profile is, in principle, a `with`-block.

**4. `profiles_to_serve(multiplex)` is already the single chokepoint** for
"which profiles does this process serve", written precisely so later
multiplexing phases need not re-derive the set.

## The blocker: secrets are process-global, and `HERMES_HOME` is not

This is the finding that determines the architecture, and it is not fixed by
FG-27.

`HERMES_HOME` is context-local. **`os.environ` is not.** And the app DSN on the
live box is resolved *through* the environment:

```yaml
# $HERMES_HOME/config.yaml
datastore:
  supabase_app:
    dsn: ${DATABASE_URL}
```

```python
# hermes_cli/config.py — _expand_env_vars
re.sub(r"\${([^}]+)}", lambda m: os.environ.get(m.group(1), m.group(0)), obj)
```

`_expand_env_vars` reads **`os.environ`**, and `reload_env()` *writes* to
`os.environ` — process-globally. Switching the `HERMES_HOME` contextvar changes
which `config.yaml` is parsed, but **not** which `DATABASE_URL` that file's
`${DATABASE_URL}` resolves to.

So in a single process serving several profiles:

- every profile's app DSN resolves to whichever `.env` was loaded last;
- the same is true of `SUPABASE_SERVICE_ROLE_KEY` — the credential that can mint
  and delete **any** account — and of every model API key;
- there is no context-local seam to fix it behind: **~2,250 `os.getenv` /
  `os.environ` call sites** outside tests.

Two consequences:

1. **A single-process multi-profile console cannot safely hold per-profile
   secrets.** This is architectural, not a bug to be fixed in passing.
2. **FG-27 Layer 3 is load-bearing for this FG.** With per-profile schemas, a
   profile that resolves the wrong DSN lands in a *different schema of the wrong
   database* — wrong, detectable, and not a data merge. Without it, the same
   mistake is a silent merge. FG-27 turns this failure mode from catastrophic to
   merely broken.

**Correction after the shared-Supabase decision — this is a strong
recommendation, not a hard blocker.** Being honest about the weakened argument:
if all profiles share one Supabase, then `DATABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` are **the same value for every profile**, so the
process-global environment cannot make them wrong. The constraint above stops
being a correctness blocker for the datastore.

What survives:

- **Per-profile secrets that genuinely differ** — model API keys are the live
  example (a profile may use a different provider or a separately-billed key),
  and any future per-profile credential. Those still collapse to whichever
  `.env` loaded last.
- **The coupling is invisible and unenforced.** Nothing declares "these secrets
  must be identical across profiles"; the day one profile is given its own
  Postgres or its own key, the multiplexed process silently uses the wrong one.
  A design that is correct only while a coincidence holds is a latent bug with a
  delayed trigger.

That argued for fan-out when it was written, because the process boundary made
the property structural instead of coincidental. **It has since been decided the
other way — see §"Architecture decision" — and the condition attached here is
what that decision must satisfy:** an explicit, tested assertion that each served
profile resolves *its own* values, failing closed rather than silently sharing.
`get_secret` now provides the failing-closed half; the test is item 8 of the
checklist.

**Latent issue to verify first (not introduced by this FG).** The gateway
already multiplexes profiles in one process, scoping each turn with
`set_hermes_home_override()`. By the reasoning above, profiles served that way
already share one `os.environ`, so a multiplexed gateway whose profiles have
different `DATABASE_URL`s or API keys resolves them globally rather than
per-profile. This is a **hypothesis from reading the code, not an observed
failure** — the live box has one profile, so it cannot be exhibiting it.
Confirming or refuting it is the **first task** of this FG, because if it is
real it is a bug in shipped code and outranks the feature.

### Verified 2026-08-12 — **confirmed, on three paths, and closed**

Two profile homes with deliberately different `.env` values, one process, real
`profile_runtime_scope()`, real files on disk. The already-migrated seams
(`get_secret`, `runtime_provider`, MCP `${VAR}` interpolation) held. Three
unmigrated paths did not, and every one of them decides a credential that a
turn actually uses:

```
config ${VAR} expansion   dsn/service_role_key → the PROCESS value, both profiles
gateway platform tokens   telegram token       → the PROCESS value, both profiles
resolve_anthropic_token   ANTHROPIC_API_KEY    → the PROCESS value, both profiles
```

Each is worse than "reads the wrong variable":

- **`_expand_env_vars`** is applied once per config load and the *expanded*
  result is cached per config path. A single unscoped load of a profile's config
  (`hermes status` walking every profile) therefore left the process-env
  expansion in the cache, and that profile's next turn was served it. The cache
  key now includes a fingerprint of the active secret scope.
- **`_apply_env_overrides`** applies every platform token as an override on top
  of the profile's own `config.yaml`, so the process environment *beat* each
  profile's `.env`. Both profiles resolved one token — which then either polls
  the wrong bot, or is refused by the same-credential collision check as a clash
  with a profile it shares no credential with. The 28 credential-shaped reads in
  that function now go through the scope; the tuning knobs beside them still read
  `os.environ`, which is correct for a deployment-level override.
- **`resolve_anthropic_token`** is the provider fallback, so a turn could be
  billed to, and authenticated as, another profile's account. Now fails closed.

A fourth, found while probing and the most damaging of the four: **any per-turn
call to `load_hermes_dotenv()` writes a whole `.env` into `os.environ` with
`override=True`** (two such callers exist on the MCP config path). In a
multiplexer that makes the process environment become the last profile to reach
that line, poisoning every unscoped read and every subprocess. It is now refused
while multiplexing is active — the interpolation those callers wanted is already
scope-aware.

### The subprocess seam — closed 2026-08-13

A contextvar does not cross a process boundary, so every spawn built its child's
environment from `os.environ` — which in a multiplexer is the **default
profile's** `.env`, loaded at import time by `gateway/run.py` before any turn
exists. `secret_scope` not mutating `os.environ` kept one secondary profile from
seeing another's values, but it could not give a child the *right* ones.

The exposure was narrower than the raw statement suggests, and worth recording
because the narrowing is deliberate design that already existed: every spawn
surface strips credentials by default (`_HERMES_PROVIDER_ENV_BLOCKLIST`,
`_ALWAYS_STRIP_KEYS`, `_is_hermes_internal_secret`), and MCP stdio spawns
allowlist their environment outright. What remained were the two paths that pass
a credential through *on purpose*: `inherit_credentials=True` for a blessed
model-driving CLI (`claude`, `codex`, `gemini`), and a skill-registered
`env_passthrough` key in the terminal. Both handed the child the default
profile's value, so a secondary profile's turn would have authenticated and
billed as the default profile.

The fix keeps provenance rather than guessing it. `load_hermes_dotenv` now
records which names it wrote into `os.environ`
(`secret_scope.note_env_file_keys`), because once loaded, a profile-owned value
and one the operator exported in the unit file are indistinguishable strings —
and only the former may be corrected. `apply_scope_to_subprocess_env` then, under
an active scope, replaces a surviving key with the scope's value and **drops** an
env-file-derived key the profile does not define, so a child fails closed rather
than inheriting a stranger's credential. It runs on the `os.environ`-derived
layer of all three builders (`_make_run_env`, `_sanitize_subprocess_env`,
`hermes_subprocess_env`) and only ever overrides or removes — it cannot re-admit
a key a spawn surface stripped, and it is a no-op with no scope installed, which
is every single-profile deployment.

Still not scope-corrected, and correctly so: the terminal's session snapshot is
a file written by the child shell and re-sourced by later commands in the *same*
backend instance, which belongs to one session and therefore one profile.

None of this was exhibiting on the box: `gateway.multiplex_profiles` is false
and `hermes-systest` serves one profile. It was a real defect in shipped code
that the first profile to be given its own credentials would have triggered.

## One gateway for all profiles (decided 2026-08-10)

**In scope for this FG: run a single gateway per box, serving every profile.**
The alternative — one daemon per profile — costs a measured **150 MB resident
each** before any conversation, on top of ~225 MB for a per-profile console. At
ten sub-goal profiles that is ~3.7 GB standing still, against 9.6 GB available
on the current box.

**The mechanism already exists and is substantially implemented.** Measured and
read on 2026-08-10:

- `gateway.multiplex_profiles` (default **false**, preserving one-gateway-per-
  profile) turns it on; `profiles_to_serve(multiplex=True)` is the single
  chokepoint for the served set.
- `_profile_runtime_scope(profile_home)` in `gateway/run.py` combines the two
  seams a multiplexer needs: `set_hermes_home_override` (config, skills, memory,
  SOUL, sessions) **and** `set_secret_scope` (that profile's `.env`).
- `agent/secret_scope.py` is the answer to the process-global environment
  problem described above: a **context-local** secret scope that propagates into
  the agent worker thread via `copy_context()`, deliberately does **not** mutate
  `os.environ` (a spawn's own environment is corrected per profile instead — see
  §"The subprocess seam"), and
  **fails closed** — when multiplexing is active an unscoped read raises
  `UnscopedSecretError` rather than silently returning the wrong profile's value.
- Same-credential collision detection: two profiles polling one bot token is
  refused at startup, at the only point that sees every profile's resolved
  credentials together.
- Port-binding platforms (`webhook`, `api_server`, `feishu`, `wecom_callback`,
  `bluebubbles`, `sms`, `msgraph_webhook`) are restricted to the default
  profile, which owns the single shared listener and serves the rest under a
  `/p/<profile>/` URL prefix. A secondary profile enabling one is a hard startup
  error, not a silently dropped adapter.
- Served profiles are recorded in runtime status for `hermes status`.

**So the work here is not implementation — it is finishing the migration.** The
fail-closed guarantee only protects callers that go through `get_secret()`, and
only **6 call sites** currently do, against ~2,250 direct `os.getenv`/
`os.environ` reads in the tree. An unmigrated `get_secret` caller fails loudly;
an unmigrated `os.getenv` caller **silently returns the wrong profile's value**.
That asymmetry is the whole risk.

Tasks:

- Audit every credential-reading path reachable from a gateway turn — provider
  keys, platform tokens, MCP server env, terminal backends, subprocess spawns —
  and migrate each to `get_secret()`. Prioritise by whether the value can differ
  per profile: bot tokens and model keys genuinely do; the app DSN and
  service-role key do not (one shared Supabase), so they are not urgent.
- A test that runs two profiles with **different** bot tokens and model keys
  through one gateway and asserts each turn resolves its own — the regression
  test the migration needs.
- Then enable `gateway.multiplex_profiles` on the box and re-measure.

## Architecture decision (2026-08-13) — one process, profile-scoped per request

Editions 1–3 recommended fan-out; edition 4's pickup prompt said multiplex. That
was a contradiction in the doc, not two readings of one plan, and it is resolved
here in favour of **one process serving every profile, entering the target
profile's scope per request**. Three reasons, in order of weight:

1. **Fan-out's load-bearing argument was "a contextvar cannot keep secrets apart,
   only the process boundary can." That is no longer true.**
   `set_secret_scope` is context-local and `get_secret` **fails closed** when
   multiplexing is on — an unscoped read raises rather than returning the wrong
   profile's value — and a spawned child's environment is corrected per profile
   (#219, #220). Remove that premise and fan-out's case is cost and deployment
   complexity in exchange for a property the seam already provides.
2. **Fan-out is incompatible with the one-gateway consolidation this same FG
   carries**, which Leo asked for on measured evidence. With
   `gateway.multiplex_profiles` on, the port-binding platforms — `api_server`,
   `webhook` and friends — are a hard startup error for a secondary profile: the
   default profile owns the single listener and serves the rest under
   `/p/<profile>/`. The per-profile HTTP endpoints a console would fan out to
   therefore *stop existing* once the consolidation lands. The FG cannot build
   both.
3. **"Keep one process per profile, exactly as today" was factually wrong for the
   console tier.** There is exactly one `hermes-dashboard` unit on the box,
   serving one `HERMES_HOME` — which is *why* FG-26's picker can only see the
   current profile. Fan-out is not the status quo here; it is N new units, N
   ports and a per-profile TLS/routing story, at ~225 MB each.

**What the decision must not lose.** Fan-out's real prize was never the secrets —
it was that **authority is re-derived at the destination**, structurally, because
a buggy console physically could not reach a profile the caller has no row in. In
one process that stops being a boundary and becomes a discipline, so it has to be
made structural by other means. These are requirements, not advice:

- **Every console-routed request enters the target profile's scope** —
  `set_hermes_home_override` *and* `set_secret_scope`, the pair
  `_profile_runtime_scope()` already establishes — before any resolution runs. One
  chokepoint, so "which profile am I in" is never a parameter threaded through
  handlers.
- **The principal is re-resolved inside that scope**, from the target profile's
  own `principals` table. The picker is a routing hint and never a grant; no row
  there is a 403/409 regardless of what the caller holds elsewhere.
- **Owner-fallback is refused on those routes** — see §"The most dangerous hole",
  which matters *more* here than under fan-out, not less: the hop is now an
  in-process call, so nothing about it looks remote enough to be suspicious.
- **FG-27's schema-ownership guard is the backstop.** A wrongly-scoped request
  fails on connect instead of reading another profile's rows, which is what makes
  a scoping bug loud rather than silent.
- **The credential migration comes first.** Only 6 of ~2,250 env reads go through
  `get_secret`; an unmigrated `os.getenv` returns the wrong profile's value
  silently. Migrate every credential read reachable from a console route *before*
  serving a second profile from one process. The risk is lower than the
  gateway's — the DSN and service-role key are identical across profiles on one
  Supabase — but "identical today" is exactly the coincidence §above warns about.
- **The service-role key argument now runs in our favour.** One process holding
  the box-wide account key is one place to protect instead of N, which is the
  shape §"global accounts, local authority" already asked for.

**Rejected alternative — fan-out.** Kept because the reasoning is the relevant
contrast, and because if the credential migration proves intractable this is the
fallback:

```
                    ┌──────────────────────────┐
   browser ────────▶│  admin console (BFF)     │  one URL, profile switcher
                    │  • reads profile registry│
                    │  • forwards the caller's │
                    │    identity, per profile │
                    └───┬──────────┬───────────┘
                        │          │
              ┌─────────▼──┐   ┌───▼────────┐   ┌────────────┐
              │ engineers  │   │ testers    │   │ hr         │   unchanged,
              │ API + DB   │   │ API + DB   │   │ API + DB   │   process-isolated
              └────────────┘   └────────────┘   └────────────┘
```

Why fan-out looked better when this was written:

- **The process boundary is what keeps secrets apart** — the one thing a
  contextvar could not do at the time, and now can.
- **No change to the datastore router.** Each profile API resolves its own
  config and DSN exactly as it does today.
- **It preserves the "independent islands" intent.** The islands keep their own
  runtimes; only a registry is shared — the same shape the repo already accepted
  for `kanban.db` at the shared root.
- **Authorisation is re-derived at the destination.** The console's profile
  picker is a routing hint, never a grant: each profile API resolves the
  caller's principal *in its own `principals` table* and 409s if absent. A
  compromised or buggy console cannot manufacture authority in a profile where
  the caller has no row.

**Profile registry.** A small control-plane record at the shared root listing
which profiles exist and how to reach each one (name, base URL, health). It
cannot live inside a profile, since each only knows about itself. It holds **no
authority data** — deliberately: authority stays in each profile's `principals`
table, so there is nothing to keep in sync and no second place to get wrong.

## The most dangerous hole: the owner fallback

`_comms_resolve_principal` falls back to **the enrolled owner** when a request
carries no interactive session:

> *Fallback: a request with no interactive session (an internal caller, a
> token-authed service, or a test client) resolves to the enrolled owner.*

That is correct today, where the only sessionless callers are local internal
ones. On any console-routed request it becomes an **escalation vector**: if the
caller's identity is not carried into the target profile's scope — dropped on one
code path, or a token accepted without a subject — the request resolves to **that
profile's owner**. CFO's misrouted request against `engineers` would not be
denied; it would be executed as the owner of `engineers`.

The in-process decision makes this sharper, not softer. A fan-out hop is an HTTP
call with a visible identity header, so a missing identity is conspicuous; an
in-process entry into another profile's scope carries whatever ambient state the
handler happens to hold, and looks like a function call.

Requirements, all of them tests:

- The console route **must** carry the caller's verified subject into the target
  profile's scope, and resolution there must **refuse owner-fallback** — no
  verified subject on those routes is a 401, never an owner.
- Verify the caller's **original GoTrue access token** at the destination, the
  same JWT a browser would present, so identity is never *asserted* by the
  routing layer — the property that holds whether the hop is a socket or a call.
- Negative test: a console request with the identity header stripped must fail
  closed, not fall back.

This single behaviour is the difference between a scoped console and a root
console with a dropdown.

## Scope

**In:**

- profile registry at the shared root (`hermes profile registry` CRUD, health);
- account-level verbs (ban/delete/reset) behind one guarded chokepoint — not a
  relocation, see §"global accounts, local authority";
- one console with a profile switcher listing **only** profiles where the caller
  holds an `admin`/`owner` principal row, each request entering the target
  profile's scope at one chokepoint;
- identity carried into that scope + owner-fallback refusal on console routes;
- the credential-read migration for every path a console route reaches, before a
  second profile is served from one process;
- FG-26's create-user form: the read-only "creating in: X" label becomes a real
  picker over the caller's administered profiles;
- audit: every cross-profile administrative action records actor, target
  profile and target user (C5), in the **target** profile's ledger.

**Out:**

- ~~users spanning profiles (still exactly one profile per user);~~ *retired —
  one account may hold `principals` rows in several profiles (§"Cloud-agent prompt" item 1);*
- shared memory, skills or agent state across profiles;
- ~~in-process multiplexing of profiles in the web tier (see the blocker);~~
  *superseded by §"Architecture decision (2026-08-13)": the dashboard already
  serves profiles per request in one process;*
- a second authority model — entitlement remains the `principals` row.

## Prerequisites and open decisions

1. ~~Do all profiles share one GoTrue?~~ **Answered 2026-08-10: yes, one shared
   Supabase instance.** The simplification in §"What already exists" holds. It
   also brings the account-level authority problem below, and makes FG-27
   Layer 3 an absolute prerequisite rather than a hardening measure (one
   Supabase = one Postgres = every profile on the same DSN, so without
   profile-derived schemas a second profile merges into the first on contact).
2. **FG-27 Layers 1+3 must be merged** (see above).
3. **Verify or refute the multiplexed-gateway environment issue** before
   building anything.
4. One URL with a switcher (assumed here) vs. per-profile consoles with
   separate logins. The latter is nearly free and needs no registry — worth
   pricing as the fallback if (1) turns out badly.

## Testing requirements

- **Negative matrix, real Postgres:** CFO cannot list, create, update, delete or
  invite in `engineers`/`testers`; CTO cannot in `hr` — asserted at the profile
  API, not only in the console.
- **Owner-fallback refusal:** a console-routed request with no forwarded
  identity is rejected; explicitly assert it does **not** resolve to the owner.
- **Picker is not a grant:** a request naming a profile the caller does not
  administer is refused even when the console offered it.
- **Secret isolation:** two profiles with different DSNs and different
  service-role keys, exercised concurrently, each act on their own database —
  the regression test for the process-global environment problem.
- **Audit:** cross-profile actions land in the target profile's ledger with the
  acting subject.
- Registry: unreachable profile degrades gracefully (switcher marks it down;
  no request is silently routed elsewhere).

## System testing (system-test box)

On `hermes-systest`: create a second profile with its own schema (FG-27), enrol
one admin in both and one admin in only one, and confirm from the console that
the second admin cannot see or act on the profile they are not enrolled in —
including with a hand-crafted request naming that profile directly.

## Dependencies

- **Blocked by:** nothing outstanding. FG-27 (all layers, system-tested, PR #210) and
  FG-26 (system-tested, PR #217) are both **done and deployed**.
- **Related:** C1 (principal), C3 (datastore router), FG-20 (BFF), the kanban
  identity gap below.

## The other side of a shared account system: global accounts, local authority

Sharing one Supabase gives FG-28 its clean entitlement model, but it also means
an **account** is a box-wide object while **authority** is per profile. The
administrative verbs FG-26 treats as one thing are actually two:

| kind | operations | blast radius |
|---|---|---|
| **enrolment-level** | add / remove / re-role the `principals` row, group membership | the acting profile only |
| **account-level** | GoTrue ban (deactivate), delete, set/reset password | **every profile the account is enrolled in** |

`MemberService` holds the GoTrue admin client and the **service-role key**, and
most of its mutations are gated by `require_member_admin`, which checks the
actor's role *in the current profile*. On that reading an admin of `hr` could ban
an account also enrolled in `engineers` and revoke their access there — per-profile
authority exercised through a globally-scoped credential.

### Re-read against the shipped code, 2026-08-13 — the hazard is latent, not live

> **Correction (2026-11-01):** the `set_password` row below is wrong. An admin
> mints the activation token through `issue_invitation` and receives it raw, so
> redemption *is* an admin-reachable account-level verb (password set + ban
> lift) — see §"Revised plan (2026-11-01)", security finding 1, and step A1.

FG-26 shipped, so this is now a question about code rather than intent, and the
code does **not** expose the escalation. Verified in `hermes_cli/members.py` at
`develop`:

```
deactivate (set_member_active)  flips principals.active — an un-enrol, no GoTrue call
delete_member                   require_owner, and the account is deliberately left alone
_GoTrueAdmin.set_banned         no production caller reaches it as an admin verb
set_password                    only the invitation/reset redemption path — the account
                                holder presenting a valid single-use token
delete_user                     only rollback of an enrolment the same request just made
```

So **there is currently no admin-reachable account-level verb**: requirement 1
below shipped as the actual behaviour, and requirement 2 was not approximated —
it was made unnecessary by not exposing the verbs at all. The table above
describes the blast radius those verbs *would* have, and the hazard is that
`set_banned` is a working primitive sitting behind the shared key with nothing but
absence in front of it. A future contributor wiring it to a route inherits
`require_member_admin` by convention and reintroduces the escalation silently.

Symmetrically: **every profile's process holds a key that can mint an account
valid in every profile**, so compromising one profile's process is a box-wide
account-system compromise. Fan-out would have meant N processes holding it; the
one-process decision (§"Architecture decision") means one, which is the shape the
"preferred" requirement below already asked for.

Requirements (mirrored in FG-26 §3.5):

- **"Deactivate" in a profile context means un-enrol**, not ban — the correct
  per-profile verb, and the default the UI offers.
- **Account-level operations require owner, or that the target is enrolled
  solely in profiles the actor administers** — checked server-side across
  profiles, with the affected profiles named in the confirmation dialog.
- **~~Preferred:~~ relocation behind the control plane — decided 2026-08-13:
  NOT in FG-28's scope.** The stale version of this line conditioned the decision
  on "before FG-26 ships its delete/deactivate UI"; FG-26 shipped (#217), so the
  decision is recorded here instead. Two reasons it is moot rather than deferred:
  the one-process decision (§"Architecture decision") already puts the
  service-role key in exactly one place, which was this requirement's whole prize;
  and per §"Re-read against the shipped code" there is **no admin-reachable
  account-level verb to relocate**. FG-26's UI does not have to be rebuilt.
- **In scope instead, and small: a chokepoint, so absence stops being the
  control.** Any account-level verb must pass one guarded seam that requires
  `owner` **or** that the target is enrolled solely in profiles the actor
  administers — with a test that a bare `require_member_admin` route cannot reach
  the GoTrue admin client. FG-28 is the right FG for it because FG-28's
  cross-profile read is what makes "solely in profiles the actor administers"
  computable for the first time; before it, that check could only be approximated,
  which is why FG-26 correctly refused to ship it.

## Implementation review (2026-08-14) — what shipped, and the three defects

Four slices landed on `fg-28/profile-admin` (#225, then #227/#229 into `main`):
`hermes_cli/profile_registry.py` (the derived registry + `hermes profile
registry`), `_scoped_secret()` in `members.py` (the admin-credential reads moved
onto `get_secret`), `hermes_cli/console_scope.py` (the chokepoint core), and the
`require_console_scope` dependency wiring it into the console routes. The core is
sound: authority is re-derived from the target profile's own `principals`, the
picker grants nothing, and 23 unit tests hold those invariants against a
synthetic store.

The defects were all in the **wiring**, which is where this architecture's risk
actually lives, and none of them were visible to a test of the core:

**1. Authority in one profile, effect in another.** `deactivate` and `activate`
called `_comms_member_service` (which re-derives the caller in the target
profile) without declaring `require_console_scope`, so the `MemberService` was
built after the scope had closed — `get_hermes_home()` resolved back to the
*acting* profile. `POST …/deactivate?profile=hr` checked the caller's authority
in `hr` and then suspended the enrolment in `default`. Reproduced by recording
`get_hermes_home()` at service-construction time: `hr` with the dependency,
`default` without it.

**2. The owner fallback, on the most destructive verb.** `delete_member`
*did* declare the dependency but bound its actor with
`_comms_resolve_principal` — the legacy resolver whose documented fallback is
`principals.get_owner()`. Inside `hr`'s scope that fallback is **`hr`'s owner**,
so a sessionless `DELETE …?profile=hr` would have executed the enrolment removal
and its purge/transfer as the owner of a profile the caller may not administer.
This is §"The most dangerous hole" reached through the one route that also
resolves row ownership.

**3. `owner` treated as box-wide in the account-verb guard.**
`guard_account_level_op` returned early for `role == "owner"` — but that role is
read from the *target profile's* `principals`, and every profile has its own
owner. An `hr` owner could therefore ban an account also enrolled in
`engineers`, which is the exact escalation the guard was written to refuse,
reopened through the role most likely to hold it. A genuinely box-wide owner
still passes the general condition, because they administer every profile the
target is in, so the shortcut bought nothing. Two smaller ones with it: the
blast-radius read skipped **suspended** enrolments, though suspension is a
reversible profile-local un-enrol that another profile's admin can lift and a
ban takes that decision away from them; and `whoami`, `directory` and the
channel-link route ignored `?profile=` entirely, so a switcher would have
rendered one profile's roster and role under another profile's name.

Fixed, with the pairing now asserted **structurally** rather than route by
route — every user-management route must declare the scope dependency, and none
may bind an identity through the legacy resolver, so the next route added to the
console cannot reintroduce either defect silently.

### Still open after this review

> **Superseded (2026-11-01)** by §"Revised plan (2026-11-01)". One correction:
> a chat-only `ProfilePicker` now exists in agent-home, but it is not the admin
> switcher and it is a grant (security finding 2).

- **The switcher and the picker do not exist yet.** The backend chokepoint is
  ready and `administered_profiles()` is the list it needs, but there is no
  registry HTTP endpoint, no console switcher, and FG-26's "creating in" field is
  still current-profile-only.
- **Activation cannot cross profiles.** `/api/auth/invitations/redeem` and
  `/api/auth/invitations/request` are unauthenticated by necessity and hold no
  scope, so a token minted in `hr` is looked up in the acting profile's
  `invitations` table and fails as an invalid token. The profile has to travel
  **in the invitation link** before the cross-profile create-user picker can ship
  — otherwise it mints links nobody can redeem, which is FG-26's live activation
  bug in a new shape.
- **The guard has no call site.** Correct, and consistent with §"the hazard is
  latent, not live", but the checklist's other half — a test proving a route
  gated only by `require_member_admin` cannot reach the GoTrue admin client — is
  not written yet.
- **The credential migration is one path deep.** Only `members.py`'s
  service-role-key and URL reads go through `get_secret`; every other credential
  read reachable from a console route is still `os.getenv`.
- **Everything is still synthetic.** No real-Postgres negative matrix, no
  two-profiles-one-process secret-isolation run, no system test on the box.

### Verified against the deployed box, 2026-08-14

Three findings that only reading the runtime alongside the code produced. None
of them is a defect in what shipped; all three are places where the wiring is
correct *because of how the box happens to be provisioned* rather than because
something enforces it.

- **The fail-closed net is not armed in the console's process.**
  `_scoped_secret()` refuses to return a value when `get_secret` raises
  `UnscopedSecretError`, but that exception is only raised when multiplexing is
  *active*, and `set_multiplex_active()` has exactly one caller —
  `gateway/run.py`. The dashboard runs as its own unit, so in the process that
  actually serves the console the strict branch is unreachable: a console route
  that forgets `require_console_scope` reads the **process** credential silently,
  which is the failure the strict mode exists to make loud. The strictness should
  be armed by the console serving more than one profile, not by a gateway flag.
  Until then `test_fg28_console_routes.py`'s structural assertion is the only
  thing standing in for it.
- **A profile secret scope is its `.env` and nothing else.**
  `build_profile_secret_scope()` loads `<home>/.env` only, and `get_secret`
  treats an installed scope as authoritative with no `os.environ` fallback. So a
  profile whose `.env` does not carry `SUPABASE_URL` /
  `SUPABASE_SERVICE_ROLE_KEY` resolves an empty service-role key under
  `?profile=<it>`, `load_admin_client()` returns `None`, and every console route
  answers **503 — user management is not configured**, even though GoTrue is
  box-wide and the credential exists in the process environment. On
  `hermes-systest` this does not bite: the staging `EnvironmentFile`, the default
  home's `.env` and `maintenance`'s `.env` carry the *same* URL and service-role
  key (verified by digest, values never read out). That is a provisioning
  coincidence, not an invariant — the same coincidence edition 2 flagged for
  `DATABASE_URL`. Either treat the shared-GoTrue admin credential as box-global
  or make it part of profile creation; do not leave it to luck.
- **`?profile=` is appended to every path by the agent-home client, and only
  some routes honour it.** `HermesApiClient.scopedPath()` adds the parameter
  uniformly, on the documented assumption that "an endpoint that doesn't declare
  it ignores the parameter, so this is safe to apply uniformly". That assumption
  was true before this FG and is now half-true: `members*`, `directory` and
  `whoami` honour it, while `goals`, `traces`, `changes`, `notifications` and
  `memory` still serve the *acting* profile — under the target profile's name.
  Nothing is mis-written today (those routes are reads and profile-local writes
  in the acting profile, which is what they meant before), but the switcher must
  not be built on top of a client that cannot tell the two halves apart. Either
  extend the scope dependency across `/api/comms` or make the parameter opt-in
  per method.

## Live system test (2026-08-14) — `scripts/fg28_systest.py`

> **Historical:** `hermes-systest` is the decommissioned Alibaba box (see
> `AGENTS.md`). Re-run against the current production box only through the
> private runbook, or use the Docker e2e in step D-2 as the gate.

Run on `hermes-systest` against `main` `48973a102` (which carries the review
fixes above), as `hermes` with `HERMES_HOME=/opt/data/hermes-home-staging`, over
the box's real Postgres and the two profiles it actually has (`default`,
`maintenance`). Re-run independently on review; **6/6 both times**:

```
T1  member enrolled only in default, resolved in maintenance   REFUSED, not enrolled
T2  no subject, resolved in maintenance                        REFUSED, owner-fallback
T3  unknown profile                                            REFUSED
T4  member -> default                                          role=member   active=True
T5  leo_owner -> maintenance                                   role=owner    active=True
T6  administered_profiles(leo_owner)                           ['default', 'maintenance']
```

**What this genuinely closes.** T4 and T5 are the same process resolving the
*same* subject against two different `principals` tables (`app_prod` and
`app_prod_maintenance`) and getting two different rows, and T1 is a real
cross-schema refusal on real Postgres. The "everything is synthetic" gap is
closed for the chokepoint's identity path — this is the first FG-28 evidence that
is not a Protocol stub.

**What it cannot prove, and must not be read as proving.** The script calls
`resolve_console_principal` directly with its own `store_factory`. It never
crosses the HTTP layer, so **all three defects found in the implementation review
above would have passed it** — each lived in a route's pairing of scope and
identity, not in the function the script calls. Nor does it call
`guard_account_level_op`. Specifically still unexercised live:

- **Secret isolation with credentials that differ.** T5 proves the *schema*
  derivation is scoped; it says nothing about credentials, because the box's two
  profiles carry the same Supabase URL and service-role key (verified by digest).
  The load-bearing test — two profiles, **distinct** credentials, one process —
  needs `maintenance` to be given its own credential first, and remains the one
  test that would catch an unmigrated `os.getenv` on a console path.
- **The route path under a real session.** The box's gate answers 401 before the
  dependency runs, so nothing authenticated has driven `?profile=` through the
  handlers. `tests/hermes_cli/test_fg28_console_scope_wiring.py` covers the
  403-unknown-profile and 401-no-subject mappings over a `TestClient`, but not an
  authenticated cross-profile success or the 403-suspended path.
- **The account-verb guard**, which still has no call site and no negative test
  proving a bare `require_member_admin` route cannot reach the GoTrue admin
  client.

The script reads only; it creates no rows and needs no cleanup. It depends on the
box's live roster (a `leo_owner` in both profiles and a member enrolled only in
`default`), so it is a box script rather than a portable test — which is why it
lives in `scripts/` and not `tests/`.

## Related finding

The shared kanban board carries `owner_user_id` and `visibility` while
`principals` is per profile, so the same `user_id` denotes different people in
different profiles. A shared GoTrue subject namespace — prerequisite (1) above —
would incidentally close that ambiguity, which is a second argument for it.

## Definition of Done

Registry + one console with a switcher scoped to the caller's administered
profiles; every console request scoped to its target profile with the principal
re-resolved there and owner-fallback refused;
FG-26 create-user picker; audit in the target profile; full negative matrix and
secret-isolation tests green on real Postgres; `scripts/run_tests.sh`, `ruff`,
`ty` clean; system test passed.

## Progress checklist

- [x] **First:** verify or refute the multiplexed-gateway `os.environ` issue; file separately if real — **confirmed on three paths and fixed** (see §"Verified 2026-08-12"), and the subprocess seam closed with it (see §"The subprocess seam")
- [x] Decision recorded: single shared GoTrue across profiles — **yes**, box-wide accounts with profile-local authority (edition 2, restated in §"Cloud-agent prompt")
- [x] Profile registry at the shared root + CLI — `hermes_cli/profile_registry.py`, `hermes profile registry list|health`; derived view, no authority data
- [~] Credential reads on console-reachable paths migrated to `get_secret()` — `members.py`'s URL + service-role key only; every other console-reachable read is still `os.getenv`, and the fail-closed branch is unarmed in the dashboard process (see §"Verified against the deployed box")
- [~] One console + profile switcher scoped to administered profiles, each request scoped to its target profile — per-request scoping shipped at one chokepoint (`require_console_scope`); **no switcher**: `administered_profiles()` has no HTTP caller and no UI
- [x] Identity carried into the target scope + owner-fallback refusal on console routes (with negative tests) — 401 no-subject / 403 unenrolled / 403 suspended, plus a structural route-table test that no console route may bind an identity through the legacy resolver
- [ ] FG-26 create-user picker over administered profiles — API accepts it; `CreateUserForm` still offers the current profile only, and cross-profile activation needs the profile to travel in the invitation link first
- [~] Account-level verbs behind one guarded chokepoint (owner, or target enrolled solely in administered profiles) + a test that a bare `require_member_admin` route cannot reach the GoTrue admin client — `guard_account_level_op` shipped with 7 tests (profile-local `owner` refused, suspended enrolment counted as blast radius); no call site yet, and **the negative test is not written**
- [~] Cross-profile audit in the target profile's ledger — follows from the scope, since `MemberService` is constructed inside it; not asserted by any test
- [ ] Negative matrix + secret-isolation tests on real Postgres — still synthetic (Protocol store + monkeypatched registry); the two-profiles-one-process isolation run is the load-bearing one
- [~] System test on `hermes-systest` passed — the **principal-resolution** half passed live, 6/6, reproduced independently at `main` `48973a102` (see §"Live system test"); the secret-isolation half, the account-verb guard and the HTTP route path are still unexercised on the box

- [x] **A1** Admin-minted links cannot reset an activated or cross-profile account (guard wired + structural test) — security. `issue_invitation`: strictly-downward `ROLE_RANK`, `guard_account_level_op`, never-activated account (or an open self-service reset request → `recovery` only); `redeem_invitation` refuses `activation` for an activated account; refusals are 403
- [x] **A2** Chat turns and chat reads authorised in the requested profile; chat picker lists only enrolments — security
- [x] **B1–B5** Login lands in an enrolled profile; session carries the profile; legacy resolver profile-aware; 2FA account-level (B1–B3, B4 and B5 below)
- [x] **B1–B3** Login lands in an active enrolment and resolves `whoami` there (`?profile=` → signed last-profile hint → `default` → first; 403 `suspended` / 409 `no_principal`); the session cookie carries `profile` (old cookies → `default`); `POST /api/session/profile` + header switcher; box-wide routes never get the session profile and their pages (`/files`, `/capacity`) stay default-only. B1 needed no change to `GET /api/auth/my-profiles`
- [x] **B4** Legacy resolver profile-aware: app-wide `require_profile_scope` honours a non-acting `?profile=` (target scope for the whole handler, subject re-resolved there, no owner-fallback) or refuses it (400 on box-wide routes); `role_dependency` checks the role in the target profile
- [x] **B5** 2FA and per-person preferences are account-level at the box root, keyed by the GoTrue subject (default-profile alias kept); `/api/account/*` and `/api/me/preferences` serve anyone actively enrolled in any profile
- [ ] **C2** Activation/recovery links carry the profile (bound hash); scoped redeem/request
- [ ] Decisions D1–D4 recorded (§"Revised plan (2026-11-01)")

## Audit log

| Date | Edition | Author | Change | Rationale |
|------|---------|--------|--------|-----------|
| 2026-11-06 | 14 | devin (for Leo) | **B1–B3** landed in agent-home: login picks the landing profile among the account's *active* enrolments (`?profile=` → signed `__Host-agent_home_last_profile` hint → `default` → first in registry order; suspended everywhere → 403 `suspended`, enrolled nowhere → 409 `no_principal`) and resolves `whoami` there; the session cookie carries `profile` (old cookies read as `default`); `apiClientForRequest()` binds to it, except on B4's box-wide routes (`isBoxWidePath` mirrors `BOX_WIDE_PREFIXES`, tested against it); `POST /api/session/profile` re-runs `whoami?profile=` and rewrites the cookie only on 200; the header `ProfileSwitcher` (hidden under two enrolments) replaces the chat-only picker; `/chat?profile=` switches the session first; middleware shows `/default-profile-only` in place of the whole-box pages (`/files`, `/capacity`, `/settings/upgrade`; `lib/nav/profile-gate.ts`) while the session is not in `default` | D1 accepted. B1 needed no Python change. With B4 merged every other page follows the session profile; whole-box pages would otherwise present box state under another profile's name |
| 2026-11-06 | 13 | devin (for Leo) | **B4** landed: every API route honours `?profile=` or refuses it | Until now only `/api/comms/{whoami,members*,directory}` and the A2 chat routes acted on the profile agent-home names; every other route — the rest of `/api/comms`, the registry routers, and every `ADMIN`/`OWNER` gate — resolved the caller and served rows in the *acting* profile under the other profile's name. `hermes_cli/profile_route_scope.py` adds `require_profile_scope`, installed once as an app-wide FastAPI dependency so included routers and future routes are covered without wiring. For a profile other than the acting one it looks the name up in `get_profile_registry()` (unknown → 403, as `require_console_scope`), re-resolves the verified subject in the target's own `principals` with `resolve_console_principal` (not enrolled / suspended / no datastore → 403, never the target's owner; a sessionless operator keeps owner-operator access), and on a route with no `profile` parameter of its own holds `_scoped_to(target)` for the whole handler, so store, secrets and `HERMES_HOME` are the target's. A route that declares `profile` (config, env, cron, skills, MCP, model…) already addresses that profile itself and gets the authorisation only. Routes that reach the host or the whole box (software upgrade, VPN, git, fs, files, dashboard, ops, logs, audio, WhatsApp bridges, box quotas…) refuse a non-acting profile with 400. `role_dependency` reads the principal resolved there, so `ADMIN` with `?profile=hr` checks the caller's role in `hr`. Pass-through surfaces: chat (A2), the console routes, `/api/auth/*` incl. `my-profiles`, `/api/account/*` (B5), setup, profile CRUD. No profile, or the acting profile, is byte-identical. Structural tests over the effective route table; behaviour tests on a real temp root with a real `profiles/hr` home; a real-Postgres E2E (two derived schemas) shows `GET /api/comms/goals?profile=hr` returns hr's goals only. |
| 2026-11-06 | 12 | devin (for Leo) | **B5** landed: two-factor records and per-person preferences live at the box root (`get_default_hermes_root()/auth/{two_factor,user_prefs}`, the root the profile registry hangs off) instead of the per-request `HERMES_HOME`; `two_factor.principal_id_for_session` returns the box-wide account id (default-profile alias, else the GoTrue subject — never `""` for an authenticated subject), resolved in the default profile whichever profile the request is scoped to; `_account_login` links a login to a person by an active enrolment in **any** profile (`console_scope.enrolments`), 409 none / 403 suspended everywhere; `/api/me/preferences` keys a signed-in caller by that account id | Someone enrolled only in `hr` skipped their second step at sign-in (`principal_id_for_session` returned `""`) and got 409 from `/api/account/*`, and a scoped request could have forked the files into a profile home. Migration-free: the default profile home *is* the root (`profiles._get_default_hermes_home` = `get_default_hermes_root`), and owner records stay keyed by the alias-resolved id; a process launched with a named profile as `HERMES_HOME` keeps its older files readable (a save moves them to the root, turning 2FA off removes both). Throttles unchanged (in-process) |
| 2026-11-06 | 11 | devin (for Leo) | **A2** landed: chat turns and chat reads are authorised in the requested profile; the chat picker lists only active enrolments | D3 accepted. `_chat_principal` reads `profile` first and, for a profile other than the acting one, re-resolves the verified subject in that profile's own `principals` via `resolve_console_principal` (not enrolled / suspended / unknown → 403, no owner-fallback); the acting profile keeps `_comms_resolve_principal` byte-identically. `_chat_scope` and every profile-taking chat route (turns, stream attach/cancel/active-run, approval, create, lead, list/search/detail/messages/tags/export/rename/delete/prune/bulk-delete, activity bar) now take visibility, the turn's memory user and its principal ticket from the target profile, so a default owner who is a member of `hr` sees only their own `hr` chats. `GET /api/auth/my-profiles` (backed by the new `console_scope.enrolments`, which `enrolled_profiles`/`administered_profiles` now wrap) feeds the picker; `GET /api/profiles` is admin-only (the operator dashboard and desktop app, which carry no interactive session, are unaffected). |
| 2026-11-06 | 10 | devin (for Leo) | **A1 shipped**: `MemberService.issue_invitation` refuses a target the actor does not strictly outrank, a target enrolled in a profile the actor does not administer (`guard_account_level_op`, its first production caller, via `console_scope.principal_store_factory`), and an already-activated account (`_account_is_activated`: signed in once, or not in the banned pending state) unless the holder has an open self-service reset request, in which case only a `recovery` link is minted; `redeem_invitation` refuses `kind="activation"` for an activated account (neutral `False`, link stays spent); `AccountLevelPermissionError` → 403; `hermes member invite` shares the rule. Structural test: every route whose call graph reaches `activate_with_password`/`set_password`/`set_banned`/`delete_user`/`issue_invitation` reaches the guard or is self-service (`/api/account/password`, `/api/auth/invitations/*`, `/api/setup/owner`) | D4 accepted; closes security finding 1. Recovery for signed-in people keeps working because the console's "Send reset link" is the only reset path until links travel by mail — the admin still sees that recovery token, which C2 / a mail transport should remove |
| 2026-11-01 | 9 | devin (for Leo) | Re-reviewed against `develop` `f4a7cda8a`; added §"Revised plan (2026-11-01)" (two security findings, login/activation gaps, decisions D1–D4, phased plan A→D); corrected the 2026-08-13 account-verb claim, the Scope/Out list and the `hermes-systest` references | Leo asked for FG-28 to be reviewed against the current code and the plan revised to fit it; nothing in the FG-28 paths had changed since 2026-08-14 while chat, login and invitations grew around them |
| 2026-08-14 | 8 | devin (for Leo) | Live system test recorded, with its blind spot stated; the systest script and the HTTP wiring test landed on `develop` | Leo said FG-28 was tested and asked for the results to be reviewed. They were real and they were good — 6/6 on the box against `main` `48973a102`, reproduced independently on review, and the first FG-28 evidence that runs on real Postgres rather than a stub: one process resolving the same subject to two different `principals` rows in `app_prod` and `app_prod_maintenance`, and a genuine cross-schema refusal. But the script calls `resolve_console_principal` directly and never crosses HTTP, so **all three defects edition 7 fixed would have passed it** — every one of them lived in a route's pairing of scope and identity, not in the function under test. That is the same shape as FG-26's activation bug, where a green suite could not see a gate it never instantiated, so the checklist item is marked partial rather than done and the three things still unexercised live are named: secret isolation with credentials that actually differ (the box's two profiles share one Supabase key, so nothing there can catch an unmigrated `os.getenv`), the route path under a real session, and the account-verb guard. Also a process finding worth more than the test result: both artifacts were stranded on `fg-28/profile-admin`, whose PR was closed, so neither the systest nor the HTTP wiring test was on `develop` or `main` and the box had no copy — the evidence for the checklist item existed nowhere the repo could see it. |
| 2026-08-14 | 7 | devin (for Leo) | Implementation reviewed: three wiring defects fixed, three runtime findings recorded, checklist marked per item | Leo said the to-dos were implemented and asked for a review. The chokepoint core was sound; all three defects were in the **pairing** of scope and identity at the routes, which is exactly the risk the one-process decision moved from a process boundary onto discipline — `deactivate`/`activate` re-derived the caller in the target profile and then built the service after the scope had closed (authority in one profile, effect in another), `delete_member` declared the scope but bound its actor through the legacy owner-fallback resolver (a sessionless `DELETE …?profile=hr` would have run as `hr`'s owner), and `guard_account_level_op` short-circuited on `role == "owner"` — a role read from the *target* profile, so an `hr` owner could ban an account enrolled in `engineers`, the very escalation the guard exists to refuse. Fixed and asserted structurally over the route table rather than route by route, so the next console route cannot reintroduce either defect silently. Reading the deployed box alongside the code added three things nothing in the repo states: the fail-closed credential mode is armed only by `gateway/run.py`, so in the dashboard's own process the strict branch is unreachable; a secret scope is a profile's `.env` and nothing else, so a profile without the Supabase admin credential answers 503 on every console route, and the box only works because all three env sources carry identical values (verified by digest); and agent-home appends `?profile=` to every path while only the user-management routes honour it, so a switcher built on that client would render one profile's goals and traces under another's name. Checklist now marks partial items as partial rather than open, because "open" hid that the security core has in fact landed. |
| 2026-08-13 | 6 | devin (for Leo) | Account-level verb relocation ruled **out of scope**; replaced with a chokepoint requirement | Leo noticed this section's “decide before FG-26 ships” condition had expired — FG-26 shipped in #217 — and asked whether moving ban/delete/reset behind the control plane was still in scope. Re-read the shipped code instead of the doc's intent, and the premise turned out stale: `set_member_active` is an un-enrol with no GoTrue call, `delete_member` is owner-only and deliberately leaves the box-wide account alone, `set_password` is only the token-redemption path, `delete_user` is only enrolment rollback, and `set_banned` has **no production caller as an admin verb**. So no admin-reachable account-level verb exists to relocate, and the one-process decision already puts the service-role key in one place — relocation is moot, not deferred, and FG-26's UI does not need rebuilding. What replaces it is smaller and stronger: the escalation is currently prevented by *absence*, so any future account-level verb must pass one guarded seam requiring owner or “enrolled solely in profiles the actor administers”, asserted by a test that a bare `require_member_admin` route cannot reach the GoTrue admin client. That check is only computable once FG-28 can read across profiles, which is why FG-26 was right to refuse it. |
| 2026-08-13 | 5 | devin (for Leo) | Architecture resolved: **one process, profile-scoped per request**; fan-out demoted to a recorded rejected alternative | Leo read the doc and found the contradiction edition 4 introduced: the body recommended fan-out because “the process boundary is what keeps secrets apart” while the new pickup prompt said in-process multiplexing was the direction. Resolved in favour of one process, on three grounds. **(1)** Fan-out's argument was load-bearing on a premise that is no longer true — `set_secret_scope` is context-local and `get_secret` fails closed, and #219/#220 extended that to a spawned child's environment. **(2)** Fan-out is *incompatible* with the one-gateway consolidation this same FG carries: with `multiplex_profiles` on, port-binding platforms are a hard startup error for a secondary profile and the default profile serves the rest under `/p/<profile>/`, so the per-profile HTTP endpoints a console would fan out to stop existing. The doc was asking for two mutually exclusive runtimes. **(3)** “Keep one process per profile, exactly as today” was factually wrong for this tier — the box runs exactly one `hermes-dashboard` unit on one `HERMES_HOME`, which is precisely why FG-26's picker can only see the current profile; fan-out would have been N new units at ~225 MB, not the status quo. Recorded what the decision *costs*, because fan-out's real prize was never the secrets: authority re-derived at the destination stops being a process boundary and becomes a discipline, so the doc now requires a single scoping chokepoint, the principal re-resolved from the target profile's own `principals`, owner-fallback refused there, FG-27's schema-ownership guard as the loud backstop, and the credential migration done *before* a second profile is served — with the two-profiles-one-process secret-isolation test promoted to load-bearing. |
| 2026-08-13 | 4 | devin (for Leo) | Item 1 recorded as closed; the cloud-agent prompt rewritten for a cold pickup | Leo asked whether another agent could pick this FG up from the repo alone. The code and the findings were committed and pushed, but the prompt would have misdirected the reader on four counts: it gated the FG behind FG-27 (done and deployed), it opened with a Task 0 that is now answered (the `os.environ` leaks, confirmed on four paths and fixed in #219/#220), it still carried the retired "users belong to exactly one profile" premise, and — most consequentially — it instructed the reader to keep one process per profile **because no context-local seam for `os.environ` existed**. That seam now exists, which inverts the architectural instruction while leaving its underlying reason intact: 6 of ~2,250 env reads are migrated, and an unmigrated `os.getenv` returns the wrong profile's value silently. The prompt now states the four settled decisions (shared GoTrue with box-wide accounts and profile-local authority, FG-25 deferred, Leo's owner/admin-picks-the-profile rule, and the closed leak investigation), points at the reframing that supersedes §"Summary", and names what a cloud agent cannot do — no SSH to `hermes-systest`, so deployment and the live system test stay with the box operator. |
| 2026-08-10 | 3 | devin (for Leo) | Reframed as the goal-tree console; one-gateway-for-all-profiles brought into scope | Leo's domain model: a **profile is the instrument for one sub-goal**, not a tenant and not a container of people, and **people participate in as many profiles as their work spans**. That retires this FG's "users belong to exactly one profile" premise — an imported constraint, not one the system imposes, since one shared GoTrue subject can hold a `principals` row in several profiles with separate memory in each — and it retires FG-25 for v1, because profiles now carry the cohort structure that hierarchical groups were designed to express. The mechanics below (authority via the `principals` row, target-profile routing, owner-fallback refusal, account-vs-enrolment split) are unchanged; only the motivation is. **Also brought one gateway per box into scope**, at Leo's request and on measured evidence: a per-profile daemon is 150 MB resident before any conversation (plus ~225 MB for a per-profile console), so ten sub-goal profiles cost ~3.7 GB idle against 9.6 GB available. Reading the code corrected an earlier claim of mine: `agent/secret_scope.py` **already solves** the process-global-environment problem for the gateway path with a context-local, fail-closed secret scope that never mutates `os.environ`, alongside same-token collision detection and a shared listener with `/p/<profile>/` routing. The remaining work is finishing the migration, not building it — and the risk is precisely asymmetric: an unmigrated `get_secret()` caller raises, while an unmigrated `os.getenv` caller silently returns the wrong profile's value, with only 6 of ~2,250 env reads migrated so far. |
| 2026-08-10 | 2 | devin (for Leo) | Shared-Supabase decision resolved; account-vs-enrolment authority split added | Leo confirmed **all profiles share one Supabase instance**, closing prerequisite (1): one GoTrue, one subject namespace, so the no-new-tables entitlement model holds and the kanban identity ambiguity closes incidentally. Two corrections follow. **(a) The `os.environ` finding is weaker than written** — with one Supabase, `DATABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are the *same value* in every profile, so the process-global environment cannot make them wrong and in-process multiplexing is feasible for the datastore. What survives is per-profile secrets that genuinely differ (model API keys) and the fact that the property holds only by coincidence — nothing declares or enforces that the values must match, so the day one profile gets its own key the multiplexed process silently uses the wrong one. Fan-out is therefore downgraded from hard blocker to strong recommendation, with an explicit fail-closed assertion required if multiplexing is chosen instead. **(b) A new hole, and the sharper one:** the account is now box-wide while authority stays per profile. `MemberService` performs ban/delete/reset through the GoTrue admin API with the shared service-role key, gated only by `require_member_admin` against the *current* profile — so an `hr` admin can ban an account enrolled in `engineers` and revoke access there. Split the verbs: "deactivate" in a profile means **un-enrol**, and account-level operations need owner or a target enrolled solely in profiles the actor administers. Symmetrically, every profile process holding that key means one compromised process is a box-wide account compromise, which argues for account operations living behind the control plane. Also promoted FG-27 Layer 3 to an absolute prerequisite: one Supabase means every profile shares a DSN, so without profile-derived schemas the second profile merges into the first on contact. |
| 2026-08-10 | 1 | devin (for Leo) | Created FG doc | Leo asked for one admin to create users in several profiles (CTO → engineers+testers, CFO → hr) while users stay single-profile. Code reading found the entitlement model needs **no new tables** — the GoTrue `sub` is already `principal.user_id`, so a per-profile `principals` row *is* the per-profile grant, and `_comms_resolve_principal` already 409s for an authenticated-but-unenrolled subject. It also found the architectural constraint: `HERMES_HOME` is a contextvar but `os.environ` is not, and `dsn: ${DATABASE_URL}` resolves through `_expand_env_vars` reading `os.environ`, with ~2,250 env call sites and no context-local seam — so a single process cannot hold per-profile secrets, and the console must fan out to per-profile processes rather than multiplex in-process. Recorded the owner-fallback in `_comms_resolve_principal` as the most dangerous hole: correct today, an escalation to *the target profile's owner* the moment a sessionless service-to-service hop is introduced. Sequenced after FG-27 Layers 1+3 because per-profile schemas turn a wrong-DSN resolution from a silent merge into a detectable error. |

## Cloud-agent prompt

> **2026-11-01:** start from §"Revised plan (2026-11-01)" — steps A1 and A2
> first. Where this prompt says `hermes-systest`, read "the current production
> box via the private runbook, or the Docker e2e (D-2)".

> **[Start here. Nothing gates this FG any more: FG-26 and FG-27 are done,
> deployed and system-tested, and item 1 of this FG's checklist is closed.]**
> Repo `leolau/aquarium`, branch off `develop`. Read
> `docs/design/master-plan/README.md`, `AGENTS.md`, FG-26, FG-27, FG-29 and this
> doc — including §"Reframing", which supersedes the motivation in §"Summary".
> Goal: one admin console at one URL where an administrator manages users in
> **several** profiles, scoped to the profiles where they hold an `admin`/`owner`
> principal row.
>
> **Four things are already settled — do not reopen them.**
>
> 1. **All profiles share ONE Supabase instance**, so one GoTrue and one
>    `auth.users`. An **account is box-wide; enrolment and authority are
>    profile-local**, and the same person legitimately holds `principals` rows in
>    several profiles. The "users belong to exactly one profile" line in
>    §"Summary" was an imported constraint and is retired.
> 2. **FG-25 (hierarchical groups) is deferred.** Profiles carry the cohort
>    structure. Build no groups UI, no group CRUD, no elevation ledger.
> 3. **Leo's decision on profile assignment:** owner/admin picks the profile when
>    creating a user — never self-selection, never a default-profile fallback.
>    FG-26 shipped the picker limited to the current profile *because* this FG is
>    what makes cross-profile writes possible; widening it is your item.
> 4. **The `os.environ` question is answered and closed** (was Task 0). It was
>    real, on four paths, fixed in #219 and #220 — see §"Verified 2026-08-12" and
>    §"The subprocess seam". Do not re-probe it; do **read** it, because it is
>    the mechanism your architecture rests on.
>
> **Architecture — read §"Architecture decision (2026-08-13)" before writing
> anything; it is the decision, and §"Recommended architecture" as it stood in
> editions 1–3 is now the *rejected* alternative recorded beneath it.** Build **one
> process serving every profile, entering the target profile's scope per
> request** (`set_hermes_home_override` + `set_secret_scope` at one chokepoint),
> plus a control-plane **profile registry** at the shared Hermes root (name, base
> URL, health; **no authority data**). Fan-out to per-profile APIs is not an
> option you may re-pick unilaterally: it is incompatible with the one-gateway
> consolidation this FG also carries, since with `multiplex_profiles` on the
> port-binding platforms are a hard startup error for a secondary profile and the
> per-profile HTTP endpoints stop existing.
>
> **Two things the decision costs you, and they are your first two tasks.**
> (a) Only 6 of ~2,250 env reads go through `get_secret`, and an unmigrated
> `os.getenv` returns the wrong profile's value **silently** while `get_secret`
> raises — so migrate every credential read a console route can reach *before* you
> serve a second profile from one process, and assert it with a real test (below),
> never by inspection. (b) The process boundary was what made "authority is
> re-derived at the destination" structural; in one process you must re-resolve the
> principal inside the target profile's scope from that profile's own `principals`
> table, refuse owner-fallback there, and let FG-27's schema-ownership guard be the
> backstop that makes a scoping bug loud.
>
> **Authority model: add no new tables.** The GoTrue `sub` is already
> `principal.user_id`, so "CTO may administer engineers" means exactly "CTO has
> an `admin` row in engineers' `principals`". Absence of a row is absence of
> authority. The registry holds **no** authority data.
>
> **The critical security requirement.** `_comms_resolve_principal` currently
> falls back to the enrolled **owner** for a request with no interactive
> session. On a console-routed request that is an escalation to the target
> profile's owner. Verify the caller's original GoTrue access token — the same JWT
> a browser would present — inside the target profile's scope, and **refuse
> owner-fallback on console-routed requests**: no verified subject is 401, never
> owner. In one process this is more dangerous than it was under fan-out, because
> the hop looks like a function call rather than a service call. Add a negative
> test that strips the identity and asserts failure rather than fallback. The
> profile picker is a routing hint, never a grant: re-derive authority inside the
> target profile's scope and 409/403 when the caller has no row there, with a test
> that tries it.
>
> **Also:** turn FG-26's read-only "creating in: X" label into a picker over the
> caller's administered profiles; audit every cross-profile administrative
> action (C5) in the **target** profile's ledger.
>
> **Tests (real Postgres, not mocks):** the full negative matrix on the console
> routes; owner-fallback refusal; picker-is-not-a-grant; and a secret-isolation
> test with two profiles on different DSNs and different service-role keys served
> concurrently **by one process** — which is now the load-bearing test, not a
> nice-to-have, since it is what the process boundary used to guarantee for free.
> Then the `hermes-systest` procedure in this doc. `scripts/run_tests.sh`, `ruff`,
> `ty` clean.
>
> **What you cannot do, and must hand back.** You have no SSH path to
> `hermes-systest` and no credentials for it, so the deployment and the live
> system test stay with the box operator. Everything else — including the real-
> Postgres tests — runs locally. Note also that `tests/agent` makes **real**
> provider calls, so run focused selections rather than the whole tree, and
> compare any broad failure set against `develop` before attributing it to your
> branch.
