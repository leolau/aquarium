# FG-23 — the memory visualizer on `agent-home` (the phone), not the dashboard

**Status:** plan, implementable as written, **all decisions resolved**
(owner-confirmed, Leo 2026-08-05 — see §9). Another agent should be able to pick
this up cold and execute §4 → §5 in order without re-surveying the box or
asking anything.
**Depends on:** FG-20 (`agent-home` BFF), FG-21 (layer-4 semantic memory),
FG-22 (the visualizer + `/api/memory/explorer/*`, shipped, deployed, and
confirmed working by the owner at `https://<dashboard-host>/memory` on
2026-08-05).
**Written after surveying the live `hermes-systest` box**, not from the repo
alone. Every fact in §2 was read from the box; several are not visible in git
and they are the reason the phases are ordered the way they are.

---

## 1. Why this exists

FG-22 put the memory visualizer in `web/` — the desktop operator console at
`https://<dashboard-host>/memory`. The owner wants it on **`agent-home`**, the
mobile-first face at `https://<agent-home-host>` (FG-20), which is what he
actually opens.

Nothing about the data layer changes. FG-22's endpoints are already the right
seam and this plan consumes them **unchanged** (one additive parameter in §6):

```
GET  /api/memory/explorer/summary            counts, space health, recall use
GET  /api/memory/explorer/rows               paginated + semantic search (q, owner, topic, kind, limit, offset)
GET  /api/memory/explorer/projection         the fitted 2-D map
POST /api/memory/explorer/projection/query   place a typed query; never persisted
GET  /api/memory/explorer/documents          RAG documents (empty until ingestion)
```

They resolve the C1 principal, apply the C2 scope filter *and* Postgres RLS in
one transaction, and audit every elevated read. **This plan adds a second
*view*. It must not add a second *path to the data*.**

## 2. Ground truth: what is on the box (verified 2026-08-05)

```
public url     https://<agent-home-host>   → Caddy → 127.0.0.1:3100
unit           agent-home.service   active (running) since 2026-07-29, User=root
               WorkingDirectory=/opt/data/agent-home-app/agent-home
               EnvironmentFile=/opt/data/agent-home-app/agent-home/agent-home.env
               ExecStart=.../deploy/start.sh          (npm start → next start)
checkout       /opt/data/agent-home-app  @ db68f7554 (PR #62), branch develop
               ↑ a SECOND, FULL clone of the same repo (origin leolau/aquarium),
                 root:root, created 2026-07-22, 2.2 GB (1.6 GB of it root node_modules).
                 The application itself runs from /opt/data/hermes-agent @ ffabb3b97.
                 Only ONE thing on the box references it: agent-home.service.
build          .next/BUILD_ID mtime 2026-07-27 01:40  (111 MB)
npm layout     `agent-home` is a workspace of the ROOT package.json, so deps hoist to
               <checkout>/node_modules — `next` lives there, not in agent-home/node_modules.
               The main checkout ALREADY has that root tree (1.6 GB, `next` present),
               because the `web/` bundle is built there.
env (keys)     AGENT_HOME_SESSION_SECRET, DATABASE_URL, SUPABASE_URL,
               SUPABASE_ANON_KEY, AGENT_HOME_API_URL=http://127.0.0.1:9119,
               AGENT_HOME_DATASTORE_MODE=prod, PORT=3100,
               SUPABASE_SERVICE_ROLE_KEY, AGENT_HOME_MEDIA_BUCKET
db role        DATABASE_URL user = agent_home_app   (NOBYPASSRLS — verified in pg_roles)
node           v20.20.2 / npm 10.8.2
health         GET /login → 200,  GET / → 307 (redirects to /login unauthenticated)
```

Four consequences. Three are blockers:

1. **`agent-home` is not in the deployment path.**
   `grep agent-home /opt/data/deploy-hermes.sh` → nothing. The script pulls
   `/opt/data/hermes-agent`, reinstalls the Python package, rebuilds the `web/`
   bundle when `web/` changed, and restarts the `hermes-*` units. It never
   enters the `agent-home` checkout, never runs `npm run build`, never restarts
   `agent-home.service`. **A Memory page merged to `develop` would appear on the
   dashboard and never on the phone.** Do not assume "merged = deployed" here.
2. **It runs from a different checkout than the application.** Today the two
   `agent-home/src` trees are byte-identical (both hashed: nothing has touched
   `agent-home/` since #62), so there is no *content* drift **yet**. This
   feature is the first commit that changes `agent-home/`, which is exactly when
   the arrangement starts lying.
3. **`deploy_state.py` cannot see it.** The capture's unit glob is `hermes-*`
   (`scripts/deploy_state.py:684`) and the unit is `agent-home.service`, so it
   is absent from the state manifest and the weekly drift check is structurally
   blind to its unit, its build age and its checkout. The installed unit already
   differs from the reviewed copy in git — comments and `Documentation=` only
   (diffed, harmless) — but nothing on the box would have said so.
4. **It runs as `root`,** alone among everything on this box. That is what the
   reviewed unit in `agent-home/deploy/agent-home.service` says, so it is a
   deliberate FG-20 choice rather than drift — but a public-facing Node server
   that renders one person's memories to another is the worst place here to keep
   that property.

**Phase A0 is therefore the feature, not preparation.** Without it, A2–A4 can be
merged but not delivered.

## 3. Decisions

### D1 — Mirror the user view; demote the operator one

The endpoints are the single source of truth, so a second view costs nothing at
the data layer. The audiences differ:

| | phone (`agent-home`) | operator console (`web/`) |
|---|---|---|
| "what does it remember about me" | yes | incidental |
| the map, query placement | yes | yes |
| `column_dim` / `rows_by_model` / mixed-model staleness | no | **yes** — this is how a half-re-embedded corpus is caught |
| cross-person owner counts | only what the principal may see | same, but it is the operator's job |

So: build the phone view (§5), and **remove `/memory` from `web/`'s nav while
keeping the route and the page** (A5). The page is **not** deleted — 795 tested
lines, and the only surface showing embedding-space health (owner-confirmed,
§9.3). Do not delete `web/src/screens/MemoryPage.tsx`, its locale keys, or its
route registration.

### D2 — Memory reads go through the Python API. Never `pg`.

`agent-home` *can* read Postgres directly as `agent_home_app` (NOBYPASSRLS,
FORCE'd RLS) and for GTS it does. **Memory must not.** RLS would still scope
the rows correctly, but the elevated-read **audit** — the ledger row written in
the same transaction as a cross-person read (FG-21 P3, tightened by #106) —
lives in the Python store. A direct `SELECT` would be correctly scoped and
silently unaudited: precisely the bug #106 fixed, reintroduced by a different
route. Guard it with a test (§7).

### D3 — Do **not** send `mode`

`client.tools(mode)` forwards `AGENT_HOME_DATASTORE_MODE`. The memory methods
must **omit** `mode` entirely and let the Python layer resolve its configured
mode, because on this box `AGENT_HOME_DATASTORE_MODE=prod` and:

```
app_dev.memories    37 rows, vector(1024), BAAI/bge-m3   ← the live memory tier
app_prod.memories    0 rows, vector(256)                 ← pre-re-embed leftover
```

Forwarding `prod` would render a perfectly healthy page reporting **zero
memories** — the same misleading failure #107 fixed in the dashboard. Identity is
the exception and is already handled upstream: `principals` /
`principal_aliases` live in `app_prod` regardless of mode, because channels and
web share one identity space.

### D4 — No charting dependency. Inline SVG.

`web/` uses `@observablehq/plot` (already a dependency there). `agent-home` has
no charting package and must not gain one: Plot is an imperative DOM renderer
shipping hundreds of KB into a PWA whose point is a phone on mobile data. A
scatter plot is `<circle>` elements plus a linear scale. Budget: SVG to ~2,000
points, `<canvas>` above (§6 caps the payload before that matters).

### D5 — Identity: nothing to build

`agent-home`'s login already forwards credentials to the Python
`dashboard_auth` provider (`POST /auth/password-login`), captures the upstream
`hermes_session_at` token, resolves the principal through
`/api/comms/whoami`, and mints its own signed cookie
(`src/app/api/session/login/route.ts`). `HermesApiClient` replays that token as
both cookie and bearer, so the explorer endpoints see exactly what the dashboard
sees. `agent-home` returns its own honest `409 no_principal` when the login
subject maps to nobody — the same 409 the dashboard produced on 2026-08-04,
fixed for **both** surfaces by the alias that now exists (`hermes owner alias
admin` → `leo_owner`). **Add no fallback:** a login that maps to no principal
must keep failing loudly.

### D6 — Render server-side; no new route handlers unless a page needs refetch

`agent-home` has both patterns: RSC pages calling `apiClientForRequest()`
directly (`src/app/graph/page.tsx`), and `src/app/api/**` BFF handlers for
things the browser refetches (`comms/notifications`, `chat/*`). Memory needs
both: the first paint is RSC (§5, A2), while search, paging, the map and query
placement are client-side refetches and therefore need handlers under
`src/app/api/memory/*`. Handlers follow
`src/app/api/comms/notifications/route.ts` verbatim, including its error
mapping.

## 4. Phase A0 — put `agent-home` in the deployment path (blocker)

Own PR. No memory code. Each step is verifiable on the box.

**Read `.agents/skills/testing-hermes-systest-box/SKILL.md` first.** There is
**no SSH** to this box: the only access path is the `alibaba-cloud` MCP server's
`OOS_RunCommand`, which runs as root, fails the whole call on a nonzero exit
(end scripts with `; true`), times out at ~60 s while the remote script keeps
running, and executes under `dash` rather than bash. That skill also carries the
`agent-home` section summarising §2 and the `sudo -u hermes -H` form needed to
test the service account's real behaviour.

### A0.1 — one checkout

**Decided (§9.1):** retire `/opt/data/agent-home-app` and run from the main
checkout, so one `git pull` moves the whole system, the existing drift check
covers the source, and ~2.2 GB is reclaimed. The two-checkout variant is *not*
the plan — do not teach the deploy script to pull a second clone.

```bash
# on the box, as root via OOS RunCommand
systemctl stop agent-home
cp -a /opt/data/agent-home-app/agent-home/agent-home.env \
      /opt/data/hermes-agent/agent-home/agent-home.env   # 0600, secrets, NOT committed
chmod 600 /opt/data/hermes-agent/agent-home/agent-home.env
# `agent-home` is an npm WORKSPACE: install/build from the repo root, never
# from inside agent-home/ (that would create a second, unhoisted dep tree).
cd /opt/data/hermes-agent
npm ci                                   # already satisfied here; a no-op if the tree is current
npm run build --workspace agent-home
# edit the unit's three paths → /opt/data/hermes-agent/agent-home
systemctl daemon-reload && systemctl start agent-home
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3100/login   # expect 200
mv /opt/data/agent-home-app /opt/data/agent-home-app.retired-YYYYMMDD  # keep, don't delete
```

`agent-home/.gitignore` (or the root one) must already ignore `agent-home.env`
and `.next` — **verify before the build**, because the checkout is now a git
working tree the drift check inspects, and an untracked `.next/` would make it
permanently dirty. The retired directory stays on disk until the owner confirms
the phone works, then is removed in a follow-up (it reclaims ~2.2 GB, and
nothing but the old unit ever pointed at it).

Nothing but `agent-home.service` ever referenced that clone (verified), so the
only irreplaceable thing inside it is `agent-home.env` — copy it first, and
confirm `curl 127.0.0.1:3100/login` returns 200 from the new location **before**
moving the old directory aside.

### A0.2 — the deploy script builds and restarts it

In `deploy/hermes-deploy.sh` (the reviewed copy; the box's
`/opt/data/deploy-hermes.sh` is installed from it — and #107 already proved that
installing a changed copy is itself a drift event that must be re-captured),
mirror the existing `web/`-bundle rule:

```bash
# Rebuild agent-home only when its sources changed, or when no build exists.
# Workspace install/build: from the repo root, NOT from inside agent-home/.
if git diff --name-only "$BEFORE" "$AFTER" \
     | grep -qE '^(agent-home/|package-lock\.json$)' \
   || [ ! -f agent-home/.next/BUILD_ID ]; then
  nice -n 15 npm ci
  nice -n 15 npm run build --workspace agent-home
  systemctl restart agent-home
fi
```

`nice -n 15`: a Next build on 4 shared vCPUs must lose to the gateway. The
root `package-lock.json` is matched explicitly because it is where a workspace
dependency change actually lands — matching only `agent-home/` would rebuild
with a stale dep tree.

### A0.3 — state capture can see it

`scripts/deploy_state.py`: make `--unit-glob` **repeatable**
(`action="append"`) and default to `["hermes-*", "agent-home*"]`. Do not
comma-split a single value — the existing manifest key is per-unit and a
comma-split would silently produce one bogus glob if anyone quoted it wrong.
Then, on the box: capture → review the diff → commit the state repo. The
manifest gains `agent-home.service`, its enabled/active state and its unit hash.

### A0.4 — installed unit == git

Install the reviewed `agent-home/deploy/agent-home.service` (with A0.1's paths),
then re-run the drift check. It must go **clean**, not quiet.

### A0.5 — off `root` (own PR, immediately after A0)

**Decided (§9.2):** do it, as its own change landing straight after A0 — not
bundled with A0 and not deferred indefinitely. `User=hermes`, plus the hardening
stanza the `hermes-*` units carry
(`NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=strict`, `ProtectHome=yes`,
`ReadWritePaths=` the build dir). Requires `chown -R hermes:hermes` on the
build dir and `agent-home.env`, and `.next` must be writable because `next
start` writes its cache there. **Do not bundle this with the feature** — if it
breaks the phone, the cause should be unambiguous.

### A0 acceptance

A commit to `develop` touching only `agent-home/src` is visible at
`https://<agent-home-host>` after one deploy run, with no manual build,
and `python3 scripts/deploy_state.py check` is clean afterwards.

## 5. Phases A1–A5 — the feature

### A1 — types + the API client seam

**`agent-home/src/types/index.ts`** — mirror `hermes_cli/memory_explorer.py`
exactly. These shapes are already typed in
`web/src/screens/MemoryPage.tsx:16-95` and can be lifted verbatim; do not
"improve" the field names:

```ts
export interface MemorySpace {
  column_dim: number | null;
  rows_by_model: Record<string, number>;
  configured_model: string;
  healthy: boolean;
}
export interface MemorySummary {
  space: MemorySpace;
  totals: { memories: number; documents: number; chunks: number };
  by_owner: Record<string, number>;
  by_topic: Record<string, number>;
  by_kind: Record<string, number>;
  growth: { day: string; count: number }[];
  recall_use: {
    never_used: number;
    used_7d: number;
    top: { id: string; text: string; truncated: boolean; uses: number;
           last_used: string | null }[];
  };
}
export interface MemoryRow {
  id: string; owner_user_id: string; visibility: string; kind: string;
  topic: string | null; text: string; truncated: boolean;
  created_at: string | null; uses: number; last_used: string | null;
  elevated: boolean; provenance: string; score: number | null;
}
export interface MemoryRowsResponse {
  rows: MemoryRow[]; total: number; limit: number; offset: number;
}
export interface MemoryProjectionPoint {
  id: string; x: number; y: number; owner_user_id: string;
  topic: string | null; kind: string; elevated: boolean;
  provenance: string; label: string;
}
export interface MemoryProjection {
  algorithm: string | null;        // "pca" | "umap" | null when never fitted
  computed_at: string | null;
  stale: boolean;                  // model mismatch OR unprojected rows
  unprojected_count: number;
  points: MemoryProjectionPoint[];
  sampled?: boolean;               // added by §6
  total_points?: number;           // added by §6
}
export interface MemoryQueryPlacement {
  x: number | null; y: number | null;                    // null ⇒ no position
  nearest: { id: string; score: number }[];
  degraded?: boolean;                                    // UMAP basis unloadable
}
export interface MemoryDocument {
  id: string; owner_user_id: string; visibility: string; source_kind: string;
  source_ref: string; title: string; chunk_count: number;
  ingested_at: string | null;
}
export interface MemoryDocumentsResponse {
  documents: MemoryDocument[]; total: number;
}
```

**`agent-home/src/lib/api/client.ts`** — five methods in the existing style:

```ts
/**
 * FG-22 memory explorer (read-only). NOTE: unlike `tools()`, these
 * deliberately do NOT forward AGENT_HOME_DATASTORE_MODE — the Python layer
 * resolves the memory tier's own mode (FG-23 D3). Sending `prod` on the
 * current box would report zero memories from an empty schema.
 */
async memorySummary(): Promise<MemorySummary> {
  return this.request("/api/memory/explorer/summary");
}
async memoryRows(opts: { q?: string; topic?: string; kind?: string;
                         limit?: number; offset?: number } = {},
): Promise<MemoryRowsResponse> {
  const p = new URLSearchParams();
  if (opts.q) p.set("q", opts.q);
  if (opts.topic) p.set("topic", opts.topic);
  if (opts.kind) p.set("kind", opts.kind);
  p.set("limit", String(opts.limit ?? 25));
  p.set("offset", String(opts.offset ?? 0));
  return this.request(`/api/memory/explorer/rows?${p.toString()}`);
}
async memoryProjection(limit?: number): Promise<MemoryProjection> { ... }
async memoryQuery(text: string): Promise<MemoryQueryPlacement> {
  return this.request("/api/memory/explorer/projection/query",
                      { method: "POST", json: { text } });
}
async memoryDocuments(): Promise<MemoryDocumentsResponse> { ... }
```

`limit: 25` on a phone, not the dashboard's 50 — one screen plus a bit.

**Route handlers** under `agent-home/src/app/api/memory/`, each a copy of
`src/app/api/comms/notifications/route.ts` (401 when `getPrincipal()` is null,
`HermesApiError` → same status, otherwise 502):

```
src/app/api/memory/rows/route.ts          GET   (q, topic, kind, limit, offset)
src/app/api/memory/projection/route.ts    GET
src/app/api/memory/query/route.ts         POST  { text }
```

`summary` and `documents` need no handler — they are RSC-only.
**Do not add** any handler that writes, deletes, re-embeds or triggers a fit;
there is no such endpoint upstream and there must be no such route here.

### A2 — `/memory`: counts + rows (ships on its own)

**`src/app/memory/page.tsx`** — copy `src/app/graph/page.tsx` structurally:

```tsx
export const dynamic = "force-dynamic";

export default async function Page() {
  await requirePrincipal();
  let summary: MemorySummary | null = null;
  let first: MemoryRowsResponse | null = null;
  let error: string | null = null;
  try {
    const client = await apiClientForRequest();
    [summary, first] = await Promise.all([
      client.memorySummary(),
      client.memoryRows({ limit: 25 }),
    ]);
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load memory";
  }
  return (
    <MobileShell title="Memory">
      {error || !summary || !first ? (
        <div data-component="MemoryError">Couldn&apos;t load memory ({error}).</div>
      ) : (
        <MemoryView summary={summary} initialRows={first} />
      )}
    </MobileShell>
  );
}
```

A `409` here means "authenticated, but no principal" — render that sentence
plainly (it is an enrolment problem, not a bug) rather than the raw JSON the
dashboard showed the owner on 2026-08-04.

**`src/components/memory/MemoryView.tsx`** — `"use client"`. Phone layout, top
to bottom:

1. **Pills:** `totals.memories`, `recall_use.never_used` ("never recalled"),
   `totals.documents` when > 0. Omit `column_dim` / `rows_by_model` (D1).
2. **Search field** → `/api/memory/rows?q=`, debounced 300 ms, `offset` reset to
   0 on each new query. FG-22 sets the search floor to 0 deliberately (this is
   inspection, not recall), so **do not** filter by `score` client-side.
3. **Rows as cards:** text (already truncated server-side — respect
   `truncated` with an ellipsis, do not re-truncate), `topic` chip, `uses`, a
   relative `last_used`, and `score` when searching. A row the principal sees
   by role renders its `provenance` (`from <owner>'s memory`) — FG-21's rule
   that another person's fact is never presented as the reader's own applies to
   every surface, including this one.
4. **"Load more"** on `offset` while `rows.length < total`.

**Nav** — `src/components/nav-items.ts`. **Decided (§9.4):** Memory becomes a
primary tab and takes `Activity`'s slot; `Activity` moves to `SECONDARY_NAV`
(traces are an operator's tool, memory is the user's). No sixth primary tab —
five is the bottom-bar budget on a phone.

```ts
export const PRIMARY_NAV: NavItem[] = [
  { href: "/",       label: "Home",   glyph: "◉" },
  { href: "/graph",  label: "Graph",  glyph: "◈", hint: "GTS Centre" },
  { href: "/chat",   label: "Chat",   glyph: "✦", hint: "One-brain chat" },
  { href: "/inbox",  label: "Inbox",  glyph: "✉", hint: "Approvals + changes" },
  { href: "/memory", label: "Memory", glyph: "◇", hint: "What it remembers" },
];
// SECONDARY_NAV gains, at the top (it is the most-used of the secondary set):
//   { href: "/activity", label: "Activity", glyph: "≋", hint: "Interaction traces" },
```

`nav-items.test.ts` asserts the split — update the assertion deliberately, do
not delete it.

**Service worker** — `public/sw.js:56` already refuses to cache `/api/*` and
`/auth/*`. Confirm `/memory` itself is not precached: it is per-principal HTML.

**Acceptance:** on a phone, logged in as the owner, the page lists the real
memories, search works, and `curl` without a session redirects to `/login`.

### A3 — the map

**`src/components/memory/MemoryMap.tsx`** — `"use client"`, fetched from
`/api/memory/projection` **after first paint** (`useEffect`); counts and rows
must never wait on it. Inline `<svg viewBox="0 0 100 100">`:

- linear scale from the returned point extent (padded 5%), `<circle r="1.2">`
  per point in viewBox units so zoom keeps dots crisp;
- colour by `topic` via a stable string hash into a fixed palette (never
  `Math.random`, never index-based — the colour must survive a refetch);
- opacity by `last_used` recency where available, floor 0.35 so nothing is
  invisible;
- tap a dot → bottom sheet with `label`, `owner_user_id` and `provenance`;
- pinch-zoom by mutating `viewBox`, not CSS `transform: scale` (hit targets and
  stroke widths must stay correct);
- `elevated` points get a ring, so "this is someone else's memory" is visible on
  the map and not only in the sheet.

**Empty and degenerate states, all of which occur:**

| state | server response | render |
|---|---|---|
| never fitted | `algorithm: null, points: []` | "No map yet — it's fitted nightly at 03:00." |
| single point | one point, zero extent | centre it; **do not divide by zero** (FG-22's PCA hit exactly this) |
| N new memories | `unprojected_count: N` | "3 new memories aren't on the map yet" |
| model mismatch | `stale: true`, `unprojected_count: 0` | "This map was fitted with a different embedder — distances aren't meaningful." |

The last two must be **different sentences**: the first is a nightly job
pending, the second is a correctness warning. FG-22 collapses both into
`stale`, which is why `unprojected_count` has to be read to tell them apart.

**Never fit from a request.** Fitting is whole-corpus SVD; it belongs to
`hermes-memory-projection.timer` (nightly 03:00, `Nice=15`, installed and
verified in #108). There is no endpoint to trigger it and this plan adds none.

### A4 — query placement

A text field posting to `/api/memory/query`, drawing the placement as a hollow
labelled ring plus a "nearest memories" list resolved against the rows already
loaded (fall back to their ids when a nearest id isn't in the current page).

Two things must be stated in the UI because both are true and both surprise
people:

- the typed query is **never stored** (FG-22 embeds and discards it);
- a UMAP basis that cannot be reloaded returns `degraded: true` with `x: null,
  y: null` and *semantic* nearest neighbours instead — show the list and say the
  map has no place for it, rather than drawing a position that isn't justified.

### A5 — demote `web/`'s nav entry (D1)

Remove the `/memory` item from the nav array in `web/src/App.tsx`; keep
`"/memory": MemoryPage` in `BUILTIN_ROUTES_CORE` so deep links and the operator
diagnostics survive. Keep the `nav.memory` locale keys (the page header uses
them). One line. **Deletion is explicitly rejected** (§9.3): do not remove
`MemoryPage.tsx`, its route, its tests or its locale keys.

## 6. The scaling problem, and the one API change this needs

`/projection` currently returns **every** point the principal may see. At 37
rows nobody noticed; after Drive ingestion it is tens of thousands of chunks and
megabytes of JSON to a phone. FG-22 left this open. Close it **in A3, before
ingestion**, in `hermes_cli/memory_explorer.py`:

- accept `limit` (default 5,000, hard cap 20,000);
- sample **deterministically** — `ORDER BY hashtext(id::text) LIMIT $n`, never
  `random()`, so panning or a refetch does not reshuffle the map;
- return `sampled: true` and `total_points` (the unsampled count), and render
  "showing 5,000 of 41,880" — an unlabelled sample is a lie about density;
- keep `/projection/query`'s nearest list **exact** (it runs in the database over
  all rows), so search quality never depends on what was sampled for drawing.

The sample must be applied **after** the scope predicate, not before, or a
principal's own rows could be crowded out by rows they may not see.

## 7. Testing

`vitest`, mirroring the existing files (`src/components/gts/GtsCentreView.test.tsx`
renders with `renderToStaticMarkup`; keep that style — no DOM harness is set up
for interaction tests, so assert on rendered output and test behaviour through
pure helpers).

- **`src/lib/api/client.memory.test.ts`** — each method's forwarded path and
  query string; the bridged token is sent as *both* `cookie: hermes_session_at=`
  and `authorization: Bearer`; **`mode` never appears in any memory URL** (D3).
- **`src/app/api/memory/*/route.test.ts`** — 401 without a principal;
  `HermesApiError(403)` → 403; unreachable API → 502; the POST forwards `text`
  and nothing else.
- **`src/components/memory/MemoryView.test.tsx`** — renders rows; renders
  `provenance` for an `elevated` row; renders the two staleness sentences
  distinctly; renders `totals.memories === 0` without crashing.
- **`src/components/memory/MemoryMap.test.tsx`** — extent → viewBox scaling as a
  pure exported function; one point does not divide by zero; `algorithm: null`
  renders the "no map yet" copy; `sampled` renders the count banner.
- **`src/components/memory/no-direct-db.test.ts`** — the D2 guard: read the
  memory module sources and fail if any of them import `@/lib/db`, `pg`, or the
  Supabase server client. Assert on *imports*, not on the string "select", so it
  cannot be defeated by formatting.
- **`src/components/nav-items.test.ts`** — Memory in primary, Activity in
  secondary, `PRIMARY_NAV.length <= 5`.
- **Python:** extend `tests/hermes_cli/test_memory_explorer_*.py` for §6 — the
  sample is stable across two calls with the same `limit`, `total_points` is the
  unsampled count, and the cap is enforced.

No new Postgres integration tests: authorization is unchanged, already covered
by FG-22's real-Postgres E2E, and this surface runs under a role that cannot
bypass RLS.

**Before each PR:** `npm run lint && npm run typecheck && npm run test` in
`agent-home/`, and `ruff` + the touched Python tests at the repo root. (Note
`web/`'s `npm run lint` is currently unrunnable in a fresh checkout —
`eslint-plugin-react-hooks` missing — which is a pre-existing, separate problem;
`agent-home/`'s own lint does run.)

## 8. What this plan deliberately does not do

- **No write path.** No editing, deleting, re-embedding or forgetting from the
  phone. A one-tap "forget this" on a device in a pocket is not a feature.
- **No fit trigger from the UI** (§5 A3).
- **No Realtime subscription for memory rows.** Live-updating the map would need
  a per-row projection, which does not exist — a point only has a position
  relative to a fitted basis.
- **No `mode` switcher.** One deployment, one memory tier; a picker would only
  offer a way to look at the empty 256-dim `app_prod`.
- **No RAG UI beyond the document count** until `memory.rag.enabled` is on and a
  first ingestion pass has run. `/documents` returns `{documents: [], total: 0}`
  today; render nothing rather than an empty section promising a feature.

## 9. Decisions — RESOLVED (owner-confirmed, Leo 2026-08-05)

All four are settled. **Nothing in this plan is waiting on the owner**; the next
agent executes §4 → §5 in order and does not re-open these.

1. **A0 checkout → ONE checkout.** Retire `/opt/data/agent-home-app`; run
   `agent-home` from `/opt/data/hermes-agent/agent-home` (A0.1). The
   two-checkout variant is rejected: strictly more machinery for a worse
   invariant. Move the old clone aside, do not `rm` it, until the owner
   confirms the phone works.
2. **`root` → `hermes` → YES, its own PR immediately after A0** (A0.5). Not
   bundled with A0, not deferred: if the hardening breaks the phone, the cause
   must be unambiguous.
3. **`web/`'s Memory page → DEMOTE, do not delete** (A5). Nav entry removed;
   route, component and locale keys kept. It is the only surface showing
   embedding-space health (`column_dim`, `rows_by_model`, mixed-model
   staleness), which is an operator's concern and does not belong on a phone.
4. **Bottom bar → Memory replaces Activity in `PRIMARY_NAV`;** Activity moves to
   `SECONDARY_NAV`. No sixth primary tab (A2).

### Execution order

| # | PR | Contents | Gate |
|---|----|----------|------|
| 1 | A0 | deploy path, one checkout, state-capture glob, installed unit == git | A0 acceptance (§4): an `agent-home/src`-only commit reaches the phone after one deploy run, drift check clean |
| 2 | A0.5 | `agent-home.service` → `User=hermes` + hardening | `/login` 200 as `hermes`; drift clean |
| 3 | A1+A2 | types, client methods, BFF handlers, `/memory` page (counts + rows), nav change | ships useful alone: "37 memories, 20 never recalled" is answerable nowhere else on the phone |
| 4 | A3 | `MemoryMap` + §6 deterministic projection sampling (Python) | map renders at 37 points and at a sampled cap |
| 5 | A4 | query placement | a typed query draws a marker, or degrades to nearest with no marker |
| 6 | A5 | `web/` nav demotion | dashboard `/memory` still reachable by URL |

Each row is a separate PR against `develop`, each lands and deploys before the
next begins — because on this box, until PR 1 is deployed, none of PRs 3–5 are
visible on the phone at all.
