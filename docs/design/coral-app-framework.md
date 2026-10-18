# Coral — Floating Launcher & Internal App Framework for agent-home

**Status**: proposal
**Owner**: agent-home (primary UI, FG-20 / master-plan D16, D20)
**Supersedes**: nothing — new component family + framework layer

---

## 1. What this document is

agent-home today navigates like a website: a bottom tab bar on mobile, a sidebar
on desktop, and a "More" sheet for everything that does not fit. This document
replaces all three with a single floating button — **Coral** — from which every
destination in the app can be invoked.

Coral is deliberately more than a menu. It is the first piece of an **app
framework**: agent-home becomes a shell that hosts *apps*, and Coral is the
universal launcher any app can embed. Phase 1 ships the launcher and the
registry with all current screens registered in code. Phase 2 extends the same
registry to apps users build themselves, without changing what Phase 1 ships.

### Decisions already made (product owner, 2026-08-23)

| Decision | Choice |
|---|---|
| Scope of replacement | **Full replacement** — BottomNav, SideNav, and MoreSheet all go; Coral is the only entry point on every screen size |
| Opening interaction | **Radial bloom** — tapping Coral fans items out around the button |
| App creation model | **Code-registered now, user-built later** — apps register via a manifest in this repo today; a runtime/user-defined path is designed for, not built now |
| Document scope | Both phases in one document; Phase 1 implementable, Phase 2 architectural |

### Non-goals (this document)

- No changes to the BFF, auth, or the three-tier seam (Next.js BFF → Python
  agent API → Supabase). Coral is presentation-layer only.
- No per-user customization of the launcher in Phase 1 (no reorder/pin UI).
- No new backend services. Phase 2 user-built apps reuse the existing
  Supabase `app_prod` schema.

---

## 2. Current state (verified against the code, 2026-08-23)

| Piece | File | Notes |
|---|---|---|
| Menu source of truth | `agent-home/src/components/nav-items.ts` | Hardcoded `PRIMARY_NAV` (5) + `SECONDARY_NAV` (12) `NavItem[]`; badges via named slots (`"todos-open"`) filled server-side |
| App shell | `src/components/MobileShell.tsx` | Async server component, mounted **explicitly by every page** (not via `layout.tsx`); renders header, `<main>`, and conditionally SideNav + BottomNav; fetches the todos badge via `unstable_cache` (30 s) |
| Mobile nav | `src/components/BottomNav.tsx` | Fixed bottom bar, `lg:hidden`; 5 primary + a "More" button |
| More sheet | `src/components/MoreSheet.tsx` | Hand-rolled bottom sheet over SECONDARY_NAV |
| Desktop nav | `src/components/SideNav.tsx` | Collapsible sidebar; collapse persisted via `usePersistentState` (`agent-home:sidenav-collapsed`) |
| Auth pages | `/login`, `/activate/[token]` | Pass `showNav={false}` to MobileShell |
| UI stack | Tailwind v4 only | No component library, no Radix, no animation library. Hand-rolled sheet/modal/menu primitives exist |
| State | Plain `useState` / `usePathname()` / `usePersistentState` | No state library installed |
| PWA | `public/manifest.webmanifest` + `public/sw.js` | Standalone, portrait; SW is network-first for navigations — unaffected by this change |
| Extension mechanism | **None** | New screens require editing `nav-items.ts` plus adding a route dir |

There are **17 destinations** today. This number drives the bloom geometry in
§4.3 — a naive radial menu of 17 items is unusable, so the design groups.

---

## 3. Goals

1. Every current destination remains one gesture away (two at most), with no
   loss of discoverability versus the current tab bar + sheet.
2. Exactly one navigation component family across all viewport sizes.
3. The menu is a **registry output**, not a hardcoded layout: adding a screen is
   "register a manifest entry", nothing else.
4. Coral is embeddable: any future internal app can mount the launcher and get
   consistent navigation without depending on the shell's internals.
5. Preserve the BFF invariants: server components keep `requirePrincipal()`,
   badges keep their server-side fill, the browser still never talks to Python
   or Supabase directly.

---

## 4. Phase 1 — Coral launcher

### 4.1 Component family

```
agent-home/src/components/coral/
  coral-types.ts       AppManifest interface + registry contracts
  coral-registry.ts    registerApp(), layout builder, bloom geometry (pure, SSR-safe)
  coral-apps.ts        all current screens registered as manifests
  CoralHost.tsx        the floating button + bloom overlay (client)
  CoralPetal.tsx       one launcher item (icon, label, badge, deep-link)
  coral.css            bloom geometry + animation keyframes
```

`MobileShell` stops rendering BottomNav/SideNav/MoreSheet and instead renders
`<CoralHost />` once, unless the page opts out (`showCoral={false}` for
`/login`, `/activate/[token]`). The per-page-mounting pattern of MobileShell is
kept unchanged — this redesign does not touch routing or layouts.

### 4.2 The button

- Fixed position: bottom-right, inset by the existing safe-area tokens
  (`--safe-bottom`, `--safe-top` from `globals.css`) plus a 16 px margin. It
  floats above content (`z-index` above any app surface, below toasts).
- Round, 56 px, coral-gradient fill defined as new `@theme` tokens
  (`--color-coral-*`) so all three themes (dark / light / colourful) restyle it
  via `data-theme`.
- Idle animation: slow breathing pulse (CSS keyframes, `prefers-reduced-motion`
  disables it). The pulse doubles as the "app is alive" heartbeat of the shell.
- Behaviour:
  - Tap toggles the bloom.
  - The button stays mounted and visible on every scroll position — no
    hide-on-scroll. Predictability beats screen real estate for a launcher.
  - On routes where a bottom composer exists (chat), the composer reserves
    space next to the button rather than under it; the button never overlaps
    input focus. Implemented via the existing `--bottom-nav-h` token repurposed
    as `--coral-clearance`.
  - No drag in Phase 1 (position customization is a later user-pref item).

### 4.3 Radial bloom geometry (the hard problem: 17 items)

A 17-petal radial is unreadable and unreachable. The bloom therefore shows a
**maximum of 8 petals**, arranged on a quarter-to-half arc above the button
(depending on screen width), where each petal is either:

- an **app petal** — direct deep-link to a route, or
- a **cluster petal** — a folder that fans a second, smaller arc of its member
  apps on tap (one level of nesting only; no deeper).

Default registration (mirrors today's PRIMARY/SECONDARY split, regrouped):

| Petal | Kind | Members (route) |
|---|---|---|
| Home | app | `/` |
| Tasks | app | `/todos` (carries the `todos-open` badge) |
| Chat | app | `/chat` |
| Inbox | app | `/inbox` (badge slot reserved) |
| Memory | app | `/memory` |
| Projects | app | `/projects` |
| Workspace | cluster | Files, Activity, Graph, Capacity |
| System | cluster | Users, Suggestions, Tools, Core, Webview, Settings, Onboarding |

Rules enforced by the registry, not by taste:

- Petal slots are **ordered and capped at 8**; a 9th top-level registration is a
  build-time error directing the author into a cluster.
- Cluster arcs max out at 8 members; overflow is again a build-time error
  (forces product grouping decisions instead of silent clipping).
- Deep-linking is untouched: every petal is an `<a href>`, URLs stay canonical,
  so bookmarks, service-worker navigations, and direct links behave as today.
- The active route renders its petal in the "current" state (ring highlight);
  cluster petals show a dot when any member is active.

### 4.4 Open/close & accessibility

- Open: tap. Close: tap the button again, tap the dimmed backdrop, press `Esc`,
  or navigate. No swipe gestures in Phase 1.
- Focus management: opening moves focus to the first petal; petals are real
  links, so arrow-key navigation between them and `Enter` to activate work
  with no extra scripting. Focus returns to the button on close.
- `aria-expanded` on the button, `role="menu"`/`role="menuitem"` semantics on
  the bloom, labels for every glyph (glyphs never appear without an accessible
  name — same rule as `NavGlyph` today).
- `prefers-reduced-motion`: bloom appears instantly (fade only), no arc travel.

### 4.5 Animation without new dependencies

No animation library is added. The bloom is CSS transforms on absolutely
positioned petals: each petal computes a `--petal-angle` / `--petal-radius`
custom property from its index (pure function in `coral-registry.ts`, exported
for tests), and `coral.css` transitions `transform` from `scale(0)` at the
button's origin to the computed offset. Staggered `transition-delay` by index
gives the bloom feel. Total added surface: ~120 lines of CSS in a Tailwind
`@layer` block.

### 4.6 Shared state

Phase 1 shipped with the bloom's open/close state as component-local
`useState` inside `CoralHost` — nothing else reads it. agent-home installs no
state library today, and adding one for a single component's state would be
speculative infrastructure. When Phase 2 introduces genuine cross-app shell
state (contextual action petals, app-to-app signals), that is the moment to
bring in small pinned nanostores per the repo TypeScript style, and `CoralHost`
moves its atoms then.

### 4.7 Desktop

Same component, same gesture. On `lg:` viewports the arc widens toward a
half-circle and petal radius grows; clusters open to the left of the button
instead of above when vertical space is tight. There is deliberately **no
sidebar fallback** — the point of Phase 1 is one navigation everywhere.

### 4.8 Migration & removal

1. Add `coral/` family + registry; register all 17 destinations.
2. MobileShell renders `<CoralHost />`; BottomNav/SideNav/MoreSheet become dead
   code on a flag-free branch — they are deleted in the same PR series,
   together with `nav-items.ts` (the registry supersedes it; `NavItem` fields
   map 1:1 onto `AppManifest`, nothing is lost).
3. Update/replace tests: `BottomNav.test.tsx`, `MoreSheet.test.tsx`,
   `MobileShell.test.tsx`, `nav-items.test.ts` → `coral-registry.test.ts`,
   `CoralHost.test.tsx` (vitest, node env, co-located, same conventions).
4. Home page's inline grid of secondary links (`page.tsx`) is deleted — it
   exists only because the old nav hid half the app in a sheet.
5. Deploy note: agent-home rebuilds automatically when `agent-home/` moves;
   the build runs strict `tsc` via `next build` (stricter than vitest) — run
   `npx tsc --noEmit` before pushing.

### 4.9 Risks, Phase 1

| Risk | Mitigation |
|---|---|
| Two-tap depth for clustered destinations feels slower than today's sheet | Clusters fan radially in-place — the second tap replaces scrolling a 12-row sheet; net gesture count is the same or lower. Measure in the UAT pass. |
| Bloom geometry breaks on small/landscape phones | Arc radius and angle are viewport-derived tokens; visual QA on 320 px width and standalone-PWA landscape are explicit test-plan items. |
| PWA standalone mode interferes with gestures | The bloom uses only taps and Esc; nothing conflicts with pull-to-refresh or edge swipes. |
| Badge timing regressions (todos count) | The server-side `unstable_cache` fetch moves from MobileShell's nav rendering into the registry's badge-fill step, unchanged in mechanism; a test asserts the badge slot contract. |

### 4.10 As-built revision (2026-08-23): radial bloom → grid panel

The radial bloom of §4.3 shipped, was seen live the same day, and was
replaced. The arithmetic never worked: 60 px petals on a 150 px arc give
≈34 px of centre-to-centre spacing for 8 petals over 90°, so overlap was
geometrically unavoidable at any radius a phone screen allows — and the
cluster fan on a second ring tangled with the first. The screenshot evidence
beat the design.

As built, tapping Coral opens a **grid panel** anchored above the button
(full-width sheet on phones, 26 rem rounded panel on wider viewports):
top-level apps in a 4-column grid, then one section per cluster with its
members in the same grid. Every tile is glyph + full label; nothing overlaps
at any viewport; all 17 destinations are visible with zero nesting, which
also removes the two-layer Esc choreography. The registry, manifest contract,
caps, a11y behaviour (focus-in, Esc, backdrop, arrow roving, reduced motion)
and the FAB are unchanged from this document; only the open-state geometry
(§4.3, §4.5) is superseded. `petalPosition`/`clusterMemberAngles` were deleted
with the bloom. The panel scales in from the button origin with staggered
tiles, so the "bloom" survives as motion, not as layout.

### 4.11 As-built revision (2026-08-23): Coral is two floating buttons

Coral grew from one floating button into the **two-button floating
infrastructure** of the app, one per screen corner, with the launcher itself
shrunk to stay out of the content's way:

1. **Launcher FAB — left edge.** Same registry/panel as §4.10, but the
   button is now a 44 px half-pill (`rounded-l-none rounded-r-full`) flush
   against the left edge (`left: 0`) above the safe-area inset, and the panel
   anchors bottom-left beside it. The composer clears it with a left margin
   instead of a right one.
2. **Lead-chat FAB — bottom right.** A second, larger button that opens a
   floating panel (not a route) bound to ONE long-running conversation: the
   session id is pinned in `localStorage`
   (`agent-home:lead-session`) on the first turn and reused forever. The
   panel reuses the existing chat machinery — `Composer`, `MessageBubble`,
   `StatusIndicator`, `streamChatTurn`, approval cards — so it is a surface,
   not a second chat implementation. History reloads from
   `GET /api/chat/messages` whenever the panel opens with a pinned session.
   The panel is a floating window rather than a modal: the header carries a
   **Chats** link that jumps to the full `/chat` page, and the user can drag
   the header to move it or drag either corner grip (bottom-right or
   upper-left) to resize it; the chosen geometry persists in `localStorage`
   (`agent-home:leadchat-rect`) and is restored the next time the panel
   opens.

"Long-running" is what the agent core already provides, not new machinery:
the Python conversation loop compacts context automatically when it
approaches the window limit (`agent/context_compressor.py`), so a pinned
session keeps answering without the user ever starting a new one. Lead chat
is deliberately NOT a registry app in Phase 1 — it is session infrastructure
of the shell, like the FABs themselves; user-built apps (§5) compose *with*
these two buttons rather than replacing them.

Tests: `CoralHost.test.tsx` (launcher) + `LeadChatHost.test.tsx` (open/close,
Chats link, session pinning, history reload, session reuse, move/resize
persistence for both corner grips).

---

## 5. Phase 2 — Internal app framework (architecture, not build)

Phase 1's registry IS the framework seam. Phase 2 widens where manifests come
from and what a manifest can point at — the launcher itself does not change.

### 5.1 AppManifest (the contract both phases share)

```ts
interface AppManifest {
  id: string;                 // stable, unique, kebab-case: "todos", "memory-map"
  name: string;               // human label shown on the petal
  glyph: string;              // glyph id, rendered by the existing NavGlyph system
  kind: "next-route" | "webview" | "composed";
  route?: string;             // kind=next-route: internal path, e.g. "/todos"
  webviewUrl?: string;        // kind=webview: origin-allowed URL (allow-list enforced in BFF)
  category: string;           // cluster id: "workspace" | "system" | "custom" | ...
  order: number;              // position within its tier
  badgeSlot?: string;         // named slot filled server-side, as today
  principalScope?: "owner" | "member" | "any";  // who sees the petal
}
```

`kind: "webview"` is not speculative — `/webview` (a CDP webview route) already
exists today and becomes the first non-route app kind. `kind: "composed"` is
reserved for Phase 2 user-built apps rendered by a schema-driven page.

### 5.2 Where manifests live

| Phase | Source of truth | Assembly |
|---|---|---|
| 1 | `coral-apps.ts` (code, this repo) | Build-time static list; tree-shaken into the client bundle |
| 2 | Supabase `app_prod.internal_apps` table + code manifests | BFF route `/api/apps` merges code apps + the caller's user apps (RLS-scoped via `scopedSelect`, same seam as memory/todos). The registry becomes *hydrated* on the server; the launcher is unchanged |

A user-created app is then: a row (`id`, `name`, `glyph`, `kind`, payload)
plus, for `composed` apps, a JSON document describing its content (form fields,
data views, webview URLs). A builder UI writes those rows; the launcher
discovers them on next navigation. No deploy needed for a new user app — that
is the whole point.

### 5.3 Embedding Coral in apps

Every app runs inside the shell, so embedding is opt-out, not opt-in:

- The shell mounts `CoralHost` once; an app's page renders inside `<main>`.
  This is the default and covers 95 % of apps.
- Apps that want control (e.g. immersive views) set `showCoral={false}` on
  their MobileShell call — the existing opt-out pattern.
- Phase 2 `webview` apps get Coral automatically because the launcher lives in
  the shell around the iframe; no postMessage bridge is needed for navigation.
- `useCoral()` (thin store accessor) is the only API apps may use — open/close,
  register a transient action petal (future: contextual actions like "New
  to-do"). Apps never import launcher internals; that boundary is enforced by
  ESLint project boundaries.

### 5.4 Trust and safety (Phase 2 requirements, stated now so Phase 1 doesn't paint into a corner)

- User apps run under the same principal-scoped session; the BFF never exposes
  another principal's app rows (RLS + `scopedSelect`, identical to memory).
- `webview` URLs must match an owner-managed allow-list; arbitrary URLs are
  refused at the BFF.
- `composed` app payloads are validated at write time (builder) and re-validated
  at render time; the renderer has no `dangerouslySetInnerHTML` path.
- Launcher ordering for user apps is `category: "custom"` — a ninth top-level
  tier petal — so user apps can never crowd the core petals (Phase 1's cap
  rules apply to *core* petals; the custom tier scrolls within its arc).

---

## 6. Milestones

| # | Milestone | Deliverable | Exit criteria |
|---|---|---|---|
| M1 | Registry + types | `coral-types.ts`, `coral-registry.ts`, `coral-apps.ts` | All 17 destinations registered; unit tests for grouping, caps, badge-slot contract |
| M2 | CoralHost + bloom | Component family + CSS | Bloom opens/closes, petals deep-link, active-state correct, a11y pass (focus, Esc, reduced motion) |
| M3 | Shell swap & removal | MobileShell change; BottomNav/SideNav/MoreSheet/nav-items.ts deleted | Zero references to removed components; `tsc --noEmit` clean; vitest green |
| M4 | Polish & UAT | Theming across 3 skins, 320 px + landscape QA, production deploy | Visual check on the live phone URL (human-verified, like the memory-map precedent); all routes reachable ≤ 2 gestures |
| M5 | (Phase 2, separate PR series) | `internal_apps` table, `/api/apps` hydration, builder skeleton | One demo user-created app appears in the launcher without a deploy |

M1–M4 are one PR series (or two: M1+M2, then M3+M4). M5 is deliberately not
scheduled here.

## 7. Test plan

- **Unit (vitest, co-located)**: registry caps and grouping errors; badge-slot
  fill; petal geometry function (angle/radius per index); manifest validation.
- **Component**: CoralHost open/close, backdrop, Esc, focus return, active
  petal from pathname, `showCoral={false}` opt-out.
- **Manual/UAT on device**: standalone PWA portrait + landscape; 320 px width;
  all 17 routes reachable in ≤ 2 gestures; no overlap with chat composer;
  service-worker navigations still work (URLs unchanged).
- **Deploy verification**: `npx tsc --noEmit` in `agent-home/` before push;
  after deploy, `agent-home/.next/BUILD_ID` mtime moved and
  `https://<agent-home-host>` serves the new bundle (stale-build trap
  from the ops docs).

## 8. Open questions (not blocking Phase 1)

1. Should the breathing pulse be themeable/skinnable per user brand (ties to
   the skin-engine concept on the CLI side)? Deferred — Phase 1 ships one coral
   gradient per theme.
2. Contextual action petals (`useCoral()` transient actions) — wanted for
   chat ("approve", "stop") and projects ("new run"), but they widen the
   launcher's API; parked for Phase 2.
3. Whether user-built apps ever run as true sandboxes (iframe-only with a
   message bridge) rather than composed pages — decide when the first real
   user-app requirement exists.
