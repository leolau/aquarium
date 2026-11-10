# FG-35 — Aquarium dashboard

A real-time, playful view of the whole multi-tenant box: every person is a
sea creature swimming in an aquarium, followed by small creatures for the
profiles they use. The landing page links to it and switches to it after an
idle period.

## Requirements (from Yan)

1. Real-time dashboard of the entire multi-tenant AI-harness system.
2. Each person is a sea creature: 20 creatures to choose from, one assigned
   at random when the person is created.
3. Creatures swim randomly with the person's name next to them. **Size** and
   **speed** encode usage (chats, projects, in+out tokens, …).
4. Each creature is followed by smaller creatures: the profiles that person
   is associated with.
5. Animation is continuous and smooth; usage refreshes every **5 s**.
6. Landing page gets a button to the dashboard, and switches to it after
   **X s** idle. X is set in Settings by owner/admin; default **30 s**.

## Decisions

- **Who sees it:** every signed-in person (the landing page auto-switches for
  everyone). It shows names, creatures, profile names and usage numbers only —
  no chat titles or content.
- **Route:** `/aquarium` in agent-home. Full-bleed, no chrome except a small
  "Back" button and a legend. Any pointer/key activity does **not** leave the
  dashboard by itself; Back returns to `/`.
- **Size** = `clamp(log10(1 + tokens_in + tokens_out) + chats/20 + projects/5)`
  mapped to 28–120 px. **Speed** = base drift + `log10(1 + tokens_24h)`;
  `active_now` adds a glow/bubbles. Exact curves are tuned in W2; they must be
  monotonic and bounded.
- **Followers:** one small creature per associated profile (enrolled profiles
  for members; for owner/admin, profiles they enrolled in plus `default`),
  trailing the leader with spring/boids-style following. Profile name shows
  on hover.
- **Smoothness:** one `requestAnimationFrame` loop on a single `<canvas>`
  (or one SVG layer with transforms only), dt-based motion, no React
  re-render per frame. A 5 s snapshot only retargets size/speed, which ease
  over ~1 s. Respects `prefers-reduced-motion` (slow drift, no bubbles).
  Pauses when the tab is hidden.
- **Creature choice:** stored in the person's user prefs (`creature`). New
  people get `random_creature()` at creation; people created before FG-35
  get the stable `fallback_creature(user_id)` until they pick one. Picker
  lives in the person's own settings (account section).
- **Idle seconds:** box-wide setting `aquarium.idle_seconds`, int 5–3600,
  default 30. Readable by every signed-in person (the landing page needs it),
  writable by owner/admin only. `0` is not allowed; to "turn off" use 3600.

## Contract (shared constants already on `develop`)

- Python: `hermes_cli/aquarium_creatures.py` — `CREATURES`,
  `IDLE_SECONDS_*`, `random_creature()`, `fallback_creature()`.
- TS: `agent-home/src/lib/aquarium/creatures.ts` — `CREATURES`,
  `CreatureId`, `IDLE_SECONDS_*`, `SNAPSHOT_POLL_MS`, and the
  `AquariumSnapshot` / `AquariumUser` / `AquariumMetrics` types.

### Python API (W1)

| Route | Who | Body / response |
|---|---|---|
| `GET /api/aquarium/snapshot` | signed-in | `AquariumSnapshot` (cached ≤ 4 s server-side) |
| `GET /api/aquarium/settings` | signed-in | `{ "idle_seconds": int }` |
| `PUT /api/aquarium/settings` | owner/admin | `{ "idle_seconds": int }` → same; 400 out of range, 403 otherwise |
| `GET /api/me/creature` | signed-in (self) | `{ "creature": CreatureId, "chosen": bool }` |
| `PUT /api/me/creature` | signed-in (self) | `{ "creature": CreatureId }` → same; 400 unknown id |

Metrics per person: `chats` = sessions with that `user_id` across all served
profiles' session DBs; `projects` = projects they own or are a member of;
`tokens_in`/`tokens_out` = summed session tokens; `tokens_24h` = in+out for
sessions started in the last 24 h; `active_now` = a chat turn currently
running for them (best-effort). Only active principals are listed.

### agent-home BFF (W1 adds the routes, W2/W3 consume them)

`GET /api/aquarium`, `GET|PUT /api/aquarium/settings`, `GET|PUT /api/me/creature`
proxy the Python routes with the signed-in session, following the existing
BFF route pattern.

## Work items

- [ ] **W1 Backend + BFF** — Python routes above, creature pref in
  `user_prefs`, random creature at person creation, snapshot aggregation with
  a short cache, idle-seconds setting storage, BFF proxy routes, tests.
- [ ] **W2 Dashboard page** — `/aquarium`: 20 creature SVG drawings
  (`agent-home/src/components/aquarium/creatures/`), canvas/SVG renderer with
  rAF loop, wandering + followers, name labels, size/speed mapping, 5 s
  polling with eased retargeting, legend, reduced-motion, tab-hidden pause,
  tests for mapping and polling. Smoke spec for the new route.
- [ ] **W3 Landing + Settings** — landing-page button to `/aquarium`; idle
  timer (pointer/key/scroll/focus/typing resets it; never fires while the
  composer has text, a chat is open and streaming, or a dialog is open) that
  navigates to `/aquarium` after `idle_seconds`; owner/admin Settings field
  for idle seconds; creature picker (grid of the 20 drawings) in the
  person's own settings. Tests.
- [ ] **W4 Cross-review** — integrate W1–W3, fix contract mismatches, run
  the full agent-home + relevant Python suites.
- [ ] Live check on production with ≥ 2 people.

## v2 — polish, 40 creatures, aquarium name (from Yan, after the first live check)

Requirements:

1. Use Canva to make the visuals and assets more professional and fun, with
   more animation.
2. 40 creatures instead of 20.
3. An aquarium name, configurable in Settings.
4. More realistic, dynamic seaweed, with different animations at different
   timings.
5. The legend goes away after a while.
6. Fixes from the screenshot review: creatures and name labels must not
   overlap; followers trail behind their leader (never ahead or far off);
   follower profile names readable at a glance; followers vary per person +
   profile (not one look per profile box-wide) and read clearly as sea
   creatures; legend icons legible; a much wider size range so heavy users
   are obviously bigger.

Decisions:

- **Assets:** Canva-generated, background-removed transparent WebP sprites,
  committed under `agent-home/public/aquarium/creatures/<id>.webp` (≤ 256 px,
  facing right; mirror to face left) and scenery under
  `agent-home/public/aquarium/decor/` (`backdrop` opaque 1680×944; `kelp`,
  `seagrass`, `coral-branch`, `coral-brain`, `anemone`, `rocks`
  transparent). Paths come from `creatureSprite()` / `decorSprite()` in
  `creatures.ts`. The canvas draws sprites, not the v1 SVG paths; the v1
  `CreatureIcon` switches to the sprite too (picker, legend, card).
- **40 creatures:** the 20 new ids are appended to `CREATURES` in both
  contract files, never reordered. `fallback_creature()` keeps indexing the
  original 20 so people without a saved pref keep their creature.
  `random_creature()` picks from all 40.
- **Aquarium name:** box-wide `aquarium.name` next to `aquarium.idle_seconds`,
  1–60 chars after trimming, default `Aquarium`; empty/whitespace resets to
  the default. Snapshot gains `name`. `GET /api/aquarium/settings` returns
  `{idle_seconds, name}`; `PUT` takes any subset (owner/admin only) and
  returns the full object. Shown as the dashboard title and editable in the
  same owner/admin Settings panel as idle seconds.
- **Legend:** visible on load, fades out after `LEGEND_HIDE_MS` (8 s); a small
  info button brings it back (and it re-hides after the same delay). Keyboard
  and screen-reader reachable; reduced motion just hides it without the fade.
- **Seaweed:** kelp and sea grass are drawn as segmented strands bending with
  layered sine sway — each strand has its own phase, period (≈3–9 s) and
  amplitude, plus a slow "current" gust every 20–40 s that sweeps across the
  tank, and a local push when a creature swims through. Corals, anemone
  (tentacle pulse) and rocks are placed on the seabed in 2–3 depth layers.
  Plus: caustic light on the sand, drifting light rays, particles/plankton,
  rising bubbles, occasional bubble bursts from `active_now` creatures.
- **Swimming:** body undulation (sprite squash/skew wiggle at a rate tied to
  speed), smooth turning with a flip transition, gentle depth bob; creatures
  repel each other and labels avoid each other (simple separation +
  label-collision nudge); followers spring to a slot behind the leader's
  heading; follower creature = deterministic hash of `user_id + profile`;
  follower label is a small name chip always visible (hidden only when the
  tank is crowded, then on hover). Size range widens to ~24–200 px on a
  log scale relative to the busiest person on the box.

Work items (v2):

- [ ] **V1 Backend** — `aquarium.name` storage/validation, settings GET/PUT
  shape, snapshot `name`, BFF settings route accepts the subset body, tests
  for the 40-creature list and stable fallback.
- [ ] **V2 Swimming** — sprite renderer, undulation/turning/bob, separation
  and label de-overlap, follower slots + per-person follower creature +
  name chips, wider size mapping, tests.
- [ ] **V3 Scenery** — backdrop image, layered seaweed with varied timings and
  gusts, corals/anemone/rocks, caustics, rays, particles, bubbles;
  reduced-motion and hidden-tab behaviour preserved.
- [ ] **V4 Chrome** — dashboard title from `name`, legend auto-hide + info
  button + legible icons, Settings name field, `CreatureIcon` on sprites,
  40-creature picker, i18n (en + zh-Hant).
- [ ] **V5 Cross-review** — integrate V1–V4, fix mismatches, full suites,
  browser check with mocked data.
