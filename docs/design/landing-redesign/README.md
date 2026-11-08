# agent-home landing redesign

**Status:** design approved by Yan (2026-11-08); implementation in progress.
**Source of truth:** Figma file [Aquarium agent-home — Landing redesign](https://www.figma.com/design/34Afz0PSb8yqWX8DIkjF32) (key `34Afz0PSb8yqWX8DIkjF32`). Canva produced the illustrations; the icon and loader are hand-drawn SVG.

## What's in this folder
| Path | What |
|---|---|
| `tokens.json` | Colour (dark/light), space, radius, type tokens from the Figma variables |
| `backend-spec.md` | Backend/BFF audit: what exists, what's missing, API shapes, effort |
| `mockups/` | Approved screens: desktop (needs you / all clear), mobile home, mobile Chats drawer |
| `brand/` | Brand preview page (icon 16–512 px, loader at every size, reduced motion), loader GIF, the AI-star options considered |

Shipped assets live in `agent-home/public/brand/` (icon, app icon, favicon SVG + PNG sizes, `aquarium-loader.svg`, Canva illustrations) and `agent-home/public/favicon.ico`; React wrappers are `components/brand/AquariumMark.tsx` and `AquariumLoader.tsx`.

## Brand
- **Icon:** glossy fishbowl (coral fish, teal jellyfish, amber snail, seaweed, pebbles) with one seaweed frond drawn as circuit traces ending in three Gemini-style AI stars (`#5b8cff → #a78bfa → #f0abfc`). ≤24 px uses `aquarium-favicon.svg` (bowl, fish, one frond, one star).
- **Loader:** the bowl comes alive (fish swims, jellyfish pulses, snail creeps, seaweed sways, bubbles rise). The AI stars twinkle in turn, left → top → right: swell 0.6 → 1.25, white core flash, halo bloom, faint ray flare; no rotation. 2.4 s loop, CSS inside the SVG, no JS. `prefers-reduced-motion` → one soft opacity pulse. Water follows `--color-accent`.

## Figma map
Pages: Cover & Notes `0:1` · Components `2:2` · Landing — Desktop `2:3` · Landing — Mobile `2:4`.

| Figma component | Node | Code (target) |
|---|---|---|
| `button` | 3:23 | existing buttons / `ActionButton` |
| `status-pill` | 3:39 | `components/landing/topbar/HealthPill` |
| `health-metric` | 3:40 | `components/landing/topbar/HealthPill` |
| `needs-you-badge` | 4:84 | `components/landing/topbar/NeedsYouBadge` |
| `session-row` | 3:76 | `components/landing/chats/SessionRow` |
| `profile-select` | 4:29 | `components/landing/chats/NewChatButton` (+ `chat/ProfilePicker`) |
| `pin-suggestion` | 4:54 | `components/landing/chats/PinSuggestionCard` |
| `composer` | 4:36 | `components/landing/LandingComposer` |
| `needs-you-item` | 3:77 | `components/landing/work/NeedsYouItem` |
| `work-row` | 3:89 | `components/landing/work/WorkRow` |
| `asset/aquarium-mark` | 9:52 | `components/brand/AquariumMark` |
| `asset/empty-chat`, `empty-sessions`, `needs-you-all-clear` | 9:53–9:55 | `public/brand/illustrations/*` |

Screens: desktop `5:2` (1440×900), desktop all-clear `10:237`, mobile home `6:90` (390×844), mobile Chats drawer `6:195`. Icons are `icon/<name>` components (plus, pin, message, sparkles, bell, chevron-down, arrow-up, paperclip, search, cpu, hard-drive, coins, clock, arrow-right, alert, check, user, folder, play, pencil, refresh, panel-left, x).

## Layout
- **Desktop (≥1024 px):** slim top bar (mark, health pill, Needs-you badge, account) · left sidebar 280 px (New chat + profile, search, pin suggestion card, Pinned, Recent newest-first, All chats →) · centre greeting + large composer + suggestion chips · right panel 320 px (Needs you, then Working in the background).
- **Mobile:** compact top bar (mark, Healthy dot → sheet with readings, Needs-you badge) · one-line activity strip ("4 working", tap to expand) · amber banner with the most urgent item · centred greeting and chips · composer dock with Chats (opens drawer) and New chat.

## Behaviour decisions
1. **Composer is a launcher:** Send → `POST /api/chat/new {profile}` → `/chat?session=…&profile=…&draft=…&autosend=1`. The profile chip defaults to the current profile and says "Starting in *X*" when it differs.
2. **Pins are per user, per profile** (profiles are independent islands), stored server-side so they follow the user across devices.
3. **Auto-titles:** agent-home chats call the existing `maybe_auto_title` after the first exchange; users can rename any chat inline.
4. **Pin suggestions:** one cheap, tool-less auxiliary model call over recent unfinished chats, cached and dismissible; never injected into a conversation (prompt caching).
5. **Needs you:** one `GET /api/needs-you` list feeds the badge (every page), the right panel, the mobile banner, `document.title` "(N) Aquarium", `navigator.setAppBadge`, and push. Only `reversible` actions are one-tap; everything else deep-links. A blocking banner can collapse but not be dismissed.
6. Polls: bar + needs-you 15 s while visible, refresh on focus; a failing route keeps the last good data.

## Contract
Types: `agent-home/src/types/landing.ts`. Browser reads: `agent-home/src/lib/landing/api.ts`.

| Route (BFF) | Owner workstream |
|---|---|
| `GET /api/needs-you[?include=count]` | needs-you |
| `GET /api/landing/bar` | needs-you |
| `POST /api/chat/sessions/pin`, `pinned_at` on `SessionSummary` | pins |
| `GET /api/chat/pin-suggestions`, `POST /api/chat/pin-suggestions/dismiss` | pins |
| auto-title in `gateway/session_chat.py` | auto-title |

## Workstreams
| # | Workstream | Owns |
|---|---|---|
| B1 | Auto-title for agent-home chats | `gateway/session_chat.py`, chat title refresh |
| B2 | Pins + pin suggestions | `hermes_state.py` migration, pin/suggestion routes + BFF |
| B3 | Needs-you aggregator + landing bar | `hermes_cli/needs_you.py`, `tools/approval.py` listing, BFF `needs-you`, `landing/bar`, push tag |
| F1 | Top bar | `components/landing/topbar/*` |
| F2 | Chats sidebar + drawer | `components/landing/chats/*` |
| F3 | Needs-you + background panel | `components/landing/work/*` |
| F0 | Page assembly, composer, mobile layout | `app/page.tsx`, `components/landing/*.tsx` |
