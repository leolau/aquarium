# Agent-Home Chat — Session Handoff

> Handoff notes for the `agent-home` chat interface work done against
> `leolau/aquarium` (branch `develop`), deployed to the production
> `hermes-systest` ECS box. Written so another agent can pick up the work
> without re-discovering the architecture. "a4all agent" is Leo's short name
> for the ai-prentice-4-all agent running on that box.

---

## 1. What this covers

A sequence of fixes and features for the **agent-home** chat UI — the
mobile-first web chat at `https://<agent-home-host>` that lets a
principal talk to the shared organizational brain. All work landed as small,
focused PRs into `develop`, each merged by Leo and then deployed to the live
box with the four `runbox.sh` scripts (see §6).

The root problem that kicked this off: a gated tool (Google Calendar) in
agent-home failed closed with a `no_surface` error because the chat run had no
**approval surface** attached. Fixing that unravelled into a broader hardening
of the chat surface (streaming, multi-session, uploads, themes, archive, a stop
button).

---

## 2. Architecture you must know before touching this

### 2.1 Which server agent-home actually talks to

- The browser (Next.js app under `agent-home/`) talks **only** to its own BFF
  routes under `agent-home/src/app/api/chat/*`.
- Those BFF routes proxy to the **dashboard** FastAPI server on **port 9119**
  (`hermes_cli/web_server.py`), **not** the gateway `api_server` adapter.
  - ⚠️ This tripped us up: PR #119 added the approval/stream code to the
    gateway `api_server` path, but agent-home never calls that. Every message
    `405`'d. PR #120 moved the routes onto the **dashboard** server, which is
    the one agent-home actually hits. When adding a chat endpoint, add it to
    `web_server.py` and confirm the BFF route points at `:9119`.
- Streaming endpoint: `POST /api/sessions/{session_id}/chat/stream` (SSE).
- Approval resolve endpoint: `POST /v1/runs/{run_id}/approval`.

### 2.2 The approval surface (the original bug)

- Tools listed under `approvals.tools` in `config.yaml` (e.g.
  `mcp_google_workspace_*`) require a per-call approve/deny from the user.
- The gate **fails closed**: if the running session has no "approval surface"
  (a notify callback that can push the prompt to the user), the tool is **not
  executed** and returns a `no_surface` message ("this session has no way to
  prompt them").
- agent-home chat runs as `platform=api_server`. Originally it bound the
  session context but **never registered a notify callback**, so gated tools
  failed closed.
- Fix (in `web_server.py`, the `session_chat_stream` handler): the run worker
  thread now calls, in this exact order and **in the executor thread** (the
  tool executor inherits that thread's contextvars):
  1. `set_session_vars(platform="api_server", ...)`
  2. `set_current_session_key(run_id)`
  3. `register_gateway_notify(run_id, _approval_notify)`
  The `_approval_notify` callback enqueues a redacted `approval.request` SSE
  event (it redacts the command via `gateway.run._redact_approval_command`).
  The browser renders an approve/deny card and answers via
  `POST /v1/runs/{run_id}/approval` → `resolve_gateway_approval`.
- ⚠️ Do **not** weaken the gate. The correct fix for "calendar reads are
  gated everywhere" is to attach a surface (done), not to remove tools from
  `approvals.tools`.

### 2.3 Session & approval isolation model (client side)

`agent-home/src/components/chat/ChatPane.tsx` is the heart of it. Key
invariants — preserve these when editing:

- **Per-session keying.** Everything in-flight is keyed by session id, or the
  sentinel `NEW_KEY = "__new__"` for a not-yet-persisted conversation
  (`keyOf(id) = id ?? NEW_KEY`).
  - `sendingKeys: string[]` — which sessions have a live turn.
  - `approvals: Record<key, ChatApprovalRequest>` — pending approval per session.
  - `decisions: Record<key, string>` — the inline "Approved — running X…" note.
  - `liveRef: Map<key, LiveTurn>` — buffered `{user, assistant}` text so a turn
    keeps accumulating even when you switch away from its conversation.
  - `abortRef: Map<key, AbortController>` — one controller per in-flight turn
    (added for the Stop button).
- **`selectedRef`** mirrors the selected `sessionId` for use inside async
  stream callbacks. `onThisSession()` compares the turn's origin session to
  `selectedRef.current` so late-arriving deltas are written to the correct
  thread (or just buffered) and never bleed across conversations.
- **A turn captures its `turnSessionId` up-front.** A brand-new conversation
  only learns its real session id at `run.completed`; the code adopts that
  landed id (`setSessionId(landed)`) **only if `onThisSession()`** — i.e. only
  if you haven't navigated away.
- **Streaming delta accumulation is identity-safe.** Do NOT match the live
  assistant message by object identity (`m === live`) — the first delta
  replaces the object and every later delta is dropped (this was the "reply
  stops after a few characters" bug). Update the trailing assistant bubble by
  position via `setLastAssistantContent` (in `lib/chat/messages.ts`), with the
  `liveRef` buffer as the single source of truth for accumulated text.

### 2.4 Session ordering (drag-to-reorder)

- `agent-home/src/lib/chat/session-order.ts`:
  - `SESSION_ORDER_STORAGE_KEY = "agent-home:session-order"` — persisted
    per-device as a JSON string array of ids.
  - `orderSessions(sessions, order)` — applies the manual order; unknown ids
    fall back to server order.
  - `nextActiveAfterArchive(orderedIds, archivedId)` — pure helper: which
    conversation to open after archiving the active one (next in display order,
    else previous, else `null` when none remain).
- Ordering is **display-only** — it never changes session identity, transcript
  mapping, approval routing, or isolation. Unit-tested in
  `session-order.test.ts`.

### 2.5 Attachment / upload pipeline (important — see §5)

- Browser uploads go through the BFF (`/api/chat/upload`) to a **private
  Supabase Storage bucket** `agent-home-media`, at a **principal-scoped** path
  `<user_id>/<session>/<uuid>-<name>` (`agent-home/src/lib/supabase/storage.ts`,
  `scopedMediaPath`). The browser never holds the storage key.
- Reads: the browser keeps the object **path**, not a URL. The transcript uses
  `/api/chat/media?path=<encoded path>`. The BFF verifies ownership
  (`canReadMediaPath` — first path segment must equal `slug(user_id)`,
  fail-closed, no traversal) and mints a **short-lived signed URL** per turn.
- Server materialization: on each chat turn, `web_server.py`
  `_materialize_agent_home_attachments()` downloads each signed URL server-side
  into the shared `cache/documents` dir (same place gateway/Telegram inbound
  docs land), then prepends the gateway's document context-note so the brain
  gets a **real local path** and is told to extract the text itself. Text files
  are inlined within a size cap; binaries get a "extract it yourself" note.
- SSRF guard: `_agent_home_download_allowed()` only allows the box's
  **configured Supabase origin** (exact scheme+host+port) or first-party hosted
  `https://*.supabase.co` / `*.supabase.in`. On the box that origin is
  `http://127.0.0.1:8000` (self-hosted Supabase, HTTP loopback) — this is why
  an HTTPS-only guard rejected every upload until PR #132.

---

## 3. PRs delivered this line of work (all merged into `develop`)

| PR | Title / purpose |
|----|-----------------|
| #117 | docs: refresh production ECS handoff (hermes-systest, systemd, no docker) |
| #118 | docs: consolidated security + docs-review to-do list (`docs/TODO-security-and-review.md`) |
| #119 | attach an approval surface to the api_server chat path (landed on the wrong server — see #120) |
| #120 | **serve `chat/stream` + approval-resolve on the dashboard server (`:9119`)** — fixes the 405 |
| #121 | stream the full reply (identity-safe deltas) + animated status indicator + multi-session isolation |
| #122 | inline approval result note, anytime session switching, auto-growing composer |
| #123 | auto-scroll as text streams and when the approval card / decision note appears |
| #124 | render agent replies as **sanitized** Markdown/HTML (scripts, inline handlers, `javascript:` stripped) |
| #125 | horizontal scrollable session tabs + rename/stats popup (replaces dropdown) |
| #126 | any-file-type upload (PDF/DOC/XLS/…) + archive/unarchive conversations |
| #127 | collapsible left sidebar + Settings page with Dark/Light/Colourful themes |
| #128 | prominent working indicator, drag-to-reorder session tabs, readable theme palettes (`--color-fg`) |
| #129 | materialize chat uploads so the agent can read PDFs/DOCX/XLSX (`cache/documents`) |
| #132 | allow self-hosted Supabase origin (http/loopback) in the attachment SSRF guard |
| #133 | archiving the open conversation switches to a neighbour, not a blank "New conversation" |
| #135 | **Stop button** + keep a new conversation visible in the strip while its first turn runs |

(#134, #136–#138 were adjacent memory/traceability work by other branches, not
part of this chat line.)

---

## 4. Notable bugs & their fixes (so you don't repeat them)

1. **`no_surface` on gated tools** — no approval callback registered on the
   api_server chat run. Fix: register the surface in the executor thread
   (§2.2).
2. **`chat/stream → 405`** — routes added to the wrong server. Fix: put them on
   the dashboard `web_server.py` (§2.1).
3. **Reply stops after a few characters** — delta matched by object identity.
   Fix: identity-safe positional update + `liveRef` buffer (§2.3).
4. **Uploaded PDF/DOC "invisible" to the agent** — only the unreachable
   `/api/chat/media` URL was handed to the brain. Fix: server-side
   materialization into `cache/documents` (#129).
5. **Every upload rejected on the box** — SSRF guard was HTTPS-only, but
   self-hosted Supabase signs on `http://127.0.0.1:8000`. Fix: exact configured
   origin match (#132).
6. **Archiving the open chat showed a blank "New conversation"** — archive
   called `startNewConversation()`. Fix: `nextActiveAfterArchive()` switches to
   a neighbour, empty state only when none remain (#133).
7. **White/Colourful theme text unreadable** — `--color-fg` was undefined;
   text only survived by inheritance. Fix: define `--color-fg` in every theme
   and retune palettes (#128).
8. **New conversation vanished from the top strip while its first turn ran** —
   the `__new__` chip only rendered when `activeId === null`, so switching away
   dropped it. Fix: show it whenever it is active **or** `busyKeys` includes
   `__new__`, as a clickable pending chip (#135).

---

## 5. Uploaded-file storage — answer to "does it save/list my files?"

- **Yes, persistently.** Every upload lives in the private Supabase bucket
  `agent-home-media` under `leo_owner/<session>/<uuid>-<name>`. Nothing
  auto-expires; files stay until explicitly deleted. A transient working copy
  is fetched into the box's `cache/documents` per turn for the agent to read.
- **"Remembered" ≠ "stored".** Chat uploads are **not** automatically ingested
  into long-term memory / RAG. They are only in vector memory if explicitly
  ingested (the separate `hermes rag` local-files feature, PR #131). By default
  an upload is *stored + referenced in the transcript*, not *memorized*.
- **No built-in "my files" UI** exists in agent-home yet. Uploads are
  discoverable via (a) the Supabase bucket, (b) chat transcript attachment
  refs, (c) the box `cache/documents` dir. Two offered-but-not-yet-done
  follow-ups: a Files view (list/download/delete) and cleanup of the duplicate
  / orphaned `new/`-prefixed uploads (Leo said "nothing for now").
- To list current objects, `POST {SUPABASE_URL}/storage/v1/object/list/agent-home-media`
  with the service-role key (recurse into each `<user_id>/` prefix). The
  service-role key + `SUPABASE_URL` are in the systemd `EnvironmentFile`
  `/opt/data/hermes-agent/agent-home/agent-home.env` (read from
  `/proc/<agent-home MainPID>/environ`); do not print the key.

---

## 6. Deploy & verify (production `hermes-systest`)

- Host: `hermes-systest`, ECS `i-j6c81aisv2dd8mg17yle`, region `cn-hongkong`.
  No SSH — the only access path is Alibaba Cloud Cloud-Assistant
  `RunCommand`, wrapped by `/home/ubuntu/runbox.sh <script>` (base64s a local
  script, runs it on the box, polls, prints output).
- Paths: deploy `/opt/data/hermes-agent`; Hermes home
  `/opt/data/hermes-home-staging`; service user `hermes`; agent-home on
  `:3100`; dashboard/API on `:9119`; embeddings on `127.0.0.1:8791`; public URL
  `https://<agent-home-host>`.
- The on-box deploy script is `/opt/data/deploy-hermes.sh <branch>`; it fetches
  `origin/develop`, reinstalls the package, rebuilds `agent-home` **only if
  `agent-home/` changed**, and restarts all units.
- Standard sequence (run each via `runbox.sh`):
  ```bash
  /home/ubuntu/runbox.sh /home/ubuntu/deploy_pre.sh     # current commit, health, unit states
  /home/ubuntu/runbox.sh /home/ubuntu/deploy_launch.sh  # kick off deploy-hermes.sh develop
  /home/ubuntu/runbox.sh /home/ubuntu/deploy_poll.sh    # tail build/restart progress
  /home/ubuntu/runbox.sh /home/ubuntu/deploy_verify.sh  # HEAD, routes present, BUILD_ID mtime, health
  ```
- Healthy verify looks like: `home login=200`, `home root=307`,
  `dashboard=302`, `public login=200`, all 13 units active.
- The 13 long-running units: `agent-home`, `hermes-dashboard`, `hermes-digest`,
  `hermes-email-batcher`, `hermes-email-poller`, `hermes-email-triage`,
  `hermes-embed`, `hermes-escalation`, `hermes-gateway`, `hermes-wa-batcher`,
  `hermes-wa-bridge-connectar`, `hermes-wa-bridge-personal`, `hermes-wa-triage`.
- Last deploy for this line: `develop @ 522cf415d` (PR #135), agent-home rebuilt
  `BUILD_ID 2026-08-07T07:32:05`, backup at
  `/opt/data/backups/deploy-20260807-073048`.

---

## 7. Repo conventions to follow (from `AGENTS.md` + Leo)

- Preserve per-conversation **prompt caching** and strict **message-role
  alternation**. Behavioral config in `config.yaml`; `.env` is secrets only —
  do **not** add user-facing non-secret `HERMES_*` env vars.
- Do not weaken approval controls or expose secrets. Preserve session
  isolation. Prefer edge/plugin/service-gated implementations over growing the
  core model-tool surface.
- Every React component root carries `data-component="ComponentName"`
  (`ChatPane`, `SessionTabs`, `Composer`, `DecisionNotice`, … already do).
- Behavior-contract tests, not snapshot/change-detector tests. Exercise real
  paths for file/network/security boundaries.
- Git: branch off `develop` (`devin/<epoch>-<slug>`); never push directly to
  `main`/`develop`; never `git add .` (stage only intended files); no
  destructive commands; no amend/force-push; fetch the PR template before
  opening a PR; use the builtin git/PR tools.
- Frontend checks: `cd agent-home && npm run lint && npm run typecheck && npm run build`,
  plus `npx vitest run` for touched libs.
  - ⚠️ Known pre-existing typecheck failures in
    `agent-home/src/components/memory/MemoryMap.test.tsx` (missing `rowMap`
    prop) are **unrelated** — filter them out: everything else must be clean.

---

## 8. Key files map

| Concern | File |
|---|---|
| Chat pane / all session+approval state | `agent-home/src/components/chat/ChatPane.tsx` |
| Composer (input, upload, Send/Stop) | `agent-home/src/components/chat/Composer.tsx` |
| Top session strip (tabs, drag, new chip) | `agent-home/src/components/chat/SessionTabs.tsx` |
| Approve/deny modal (bottom sheet on phones) | `agent-home/src/components/chat/ApprovalModal.tsx` |
| Archived list modal | `agent-home/src/components/chat/ArchivedModal.tsx` |
| Rename/stats popup | `agent-home/src/components/chat/SessionModal.tsx` |
| Status/working indicator | `agent-home/src/components/chat/StatusIndicator.tsx` |
| Rich (sanitized MD/HTML) render | `agent-home/src/components/chat/MessageBubble.tsx` |
| SSE stream client (`AbortSignal`) | `agent-home/src/lib/chat/stream.ts` |
| Delta accumulation helpers | `agent-home/src/lib/chat/messages.ts` |
| Session ordering + archive-next helper | `agent-home/src/lib/chat/session-order.ts` |
| Supabase storage (upload/sign/ownership) | `agent-home/src/lib/supabase/storage.ts` |
| Env accessors (bucket, keys, TTL) | `agent-home/src/lib/env.ts` |
| BFF chat routes | `agent-home/src/app/api/chat/*` |
| Dashboard server: stream, approval, materialize | `hermes_cli/web_server.py` (`session_chat_stream`, `resolve_run_approval`, `_materialize_agent_home_attachments`, `_agent_home_download_allowed`) |
| Sidebar / Settings / themes | `agent-home/src/components/SideNav.tsx`, `agent-home/src/app/settings/page.tsx`, `agent-home/src/components/ThemeScript.tsx`, `agent-home/src/app/globals.css` |

---

## 9. Open / deferred items

- **Files view** in agent-home (list/download/delete uploads) and **cleanup**
  of duplicate/orphaned `new/`-prefixed Supabase objects — offered; Leo chose
  "nothing for now".
- **`pymupdf` not installed** in the box's dashboard Python env — PDF text
  extraction currently works via manual decompression; installing `pymupdf`
  (and adding it to the environment blueprint) would make it more robust.
- **Stop button server-side scope**: aborting the stream cancels the asyncio
  driver task, but a synchronous model turn already running in the executor
  thread may still finish and be persisted server-side. Truly killing an
  in-flight turn needs cooperative cancellation deep in `run_session_turn_sync`
  — out of scope so far.
- **P0 security TODOs** from the RDS incident remain in
  `docs/TODO-security-and-review.md` (least-privilege IAM + explicit Deny, take
  the RDS master user off the box, SCP + key rotation, remove the
  bypass/harvest skill, etc.). Not started at Leo's direction ("come back
  later").
