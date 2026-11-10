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
