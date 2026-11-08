# Landing page: backend and feasibility spec

**Repo:** `leolau/aquarium` @ `develop` (`213c343b4`). **Status:** read-only audit. Nothing is implemented, no PR is open, and production was not touched.
**Scope:** features a–g of the landing page brief. Line numbers are for `213c343b4`.

---

## 0. TL;DR

| # | Feature | Exists today | Missing | Backend | Effort |
|---|---|---|---|---|---|
| a | New chat with default or chosen profile | ✅ almost all of it | A landing-page "new chat" composer that reuses existing routes | none | 0.5 d |
| b | Newest-first list, rename, auto-title | ✅ list and rename. ⚠️ **auto-title is not wired for agent-home chats** | Call `maybe_auto_title` in the web chat path, and refresh the title on the client | small | 1 d |
| c | Pin / un-pin (per user, across devices) | ❌ only browser-local drag order | Schema v19 `session_pins` table, 2 endpoints, `pinned_at` on `SessionSummary` | small | 1.5 d |
| d | Pin suggestions on page load | ⚠️ building blocks only (`tags/suggest`, `call_llm` aux) | Heuristic pre-filter, one cheap aux call, cached and dismissible | medium | 2.5 d |
| e | Active tasks/projects summary | ✅ `/api/activity/running` + `client.projects()` | One combined BFF read (optional) | none to small | 0.5–1 d |
| f | Unified "needs you" | ⚠️ spread over 7+ sources. About half already go through `NotificationStore` | `GET /api/needs-you` aggregator, a list of chat-tool approvals, push `tag`/badge, landing banner | medium | 3–4 d |
| g | Combined health + activity bar | ✅ all the data exists | Optional `needs_you_count` in the bar. Merge the two polls | small | 0.5 d (backend) |

**Total backend + BFF + client:** about 9.5–11 dev-days. UI work is not included.

**One finding to escalate:** the brief assumes "Agent can auto guess the title". Hermes has the generator (`agent/title_generator.py`), but the agent-home chat path (`gateway/session_chat.py::run_session_turn_sync`) never calls it. Today only CLI, TUI, gateway platforms and ACP get auto-titles. See §b.

---

## a. Start a new chat (default or chosen profile)

### What exists today
| Piece | Location |
|---|---|
| Python `POST /api/sessions` creates an empty session owned by the caller in the chosen profile's `state.db` (accepts `profile`, optional `id`) | `hermes_cli/web_server.py:12816` |
| BFF `POST /api/chat/new` picks the profile with `profileFromBody(body)`, so `"default"` or empty means the default profile | `agent-home/src/app/api/chat/new/route.ts`, `agent-home/src/lib/chat/profile.ts:23-31` |
| Client `createSession(sessionId?)` | `agent-home/src/lib/api/client.ts:945` |
| Profiles the user can pick from: Python `GET /api/auth/my-profiles`, BFF `GET /api/chat/profiles` | `hermes_cli/web_server.py:3634`, `agent-home/src/app/api/chat/profiles/route.ts` |
| Picker UI | `agent-home/src/components/chat/ProfilePicker.tsx` |
| Chat page accepts `?session=&profile=&draft=`. A different `profile` triggers `SwitchOnArrival`, and `draft` pre-fills the composer without sending | `agent-home/src/app/chat/page.tsx:24-46,90` |
| Lead chat (one persistent conversation per user): `GET /api/sessions/lead` | `hermes_cli/web_server.py:11609`, `agent-home/src/components/coral/LeadChatHost.tsx` |

### What is missing
No backend work. The landing composer needs a decision on behaviour:
1. **Default flow, recommended:** typing in the landing composer and pressing Send calls `POST /api/chat/new {profile}`, then `router.push('/chat?session=<id>&profile=<p>&draft=<text>')`. Because `draft` only pre-fills, this adds one extra click. To avoid the extra click, add an `autosend=1` flag to `chat/page.tsx` → `ChatPane initialDraft`. That is a UI-only change.
2. Or keep the chat on the landing page by mounting `ChatPane` in `fill` layout mode (`MobileShell` already supports `wide`/`fill`). This uses the same routes.

The profile chip defaults to `readSession().profile ?? "default"`, which matches `chat/page.tsx:41`. The list comes from `GET /api/chat/profiles`.

### API shapes (existing, for reference)
```json
// POST /api/chat/new
{ "profile": "research" }
// 200
{ "session_id": "20261108_091500_ab12cd", "source": "agent_home" }   // SessionCreateResponse, types/index.ts:572
```
**Risks:** cross-profile switching changes the profile for the whole tab (FG-28 `SwitchOnArrival`). The UI must make that obvious, for example "Starting in *research*", or users will be surprised when the sidebar list changes.

---

## b. Session list newest-first, rename, auto-title

### What exists today
| Piece | Location |
|---|---|
| Python `GET /api/sessions`: `limit, offset, archived, order=created\|recent, source, exclude_sources, cwd_prefix, profile, tag filters` | `hermes_cli/web_server.py:6417` |
| BFF `GET /api/chat/sessions`: defaults to `order=recent`, excludes `cron`, supports `limit=all` | `agent-home/src/app/api/chat/sessions/route.ts` |
| Client `sessions(...)`, `allSessions(...)` | `agent-home/src/lib/api/client.ts:866` |
| `SessionSummary` has `title, preview, last_active, is_active, archived, tags`… and **no `pinned`** | `agent-home/src/types/index.ts:382-405` |
| Rename: Python `PATCH /api/sessions/{id} {title?, archived?}` → `SessionDB.set_session_title` | `hermes_cli/web_server.py:12887`, `hermes_state.py:2934` |
| BFF `POST /api/chat/sessions/rename {sessionId,title}`, client `renameSession` | `agent-home/src/app/api/chat/sessions/rename/route.ts`, `client.ts:956` |
| Rename UI (session details popup) | `agent-home/src/components/chat/ChatPane.tsx:690-705`, `SessionTabs.tsx` |
| Title generator: `generate_title` (3–7 words, same language as the user, aux task `title_generation`), `auto_title_session`, `maybe_auto_title` (background thread, first 1–2 exchanges, skips sessions that already have a title) | `agent/title_generator.py:51,120,166`, config default `hermes_cli/config.py:1646` |
| Callers of `maybe_auto_title`: gateway platforms `gateway/run.py:18257`, plus `cli.py`, `tui_gateway`, `acp_adapter` | — |

### What is missing
- **The agent-home chat turn does not auto-title.** `hermes_cli/web_server.py` (≈12385–12470, `_run` → `gateway.session_chat.run_session_turn_sync`, `gateway/session_chat.py:119-170`) runs `agent.run_conversation` and returns without calling `maybe_auto_title`. A grep for `title_generator|auto_title` in `run_agent.py`, `gateway/session_chat.py` and `hermes_cli/web_server.py` finds nothing. Untitled agent-home sessions therefore fall back to `preview`.
- After an auto-title the client has no signal to refresh. The title lands asynchronously, a few seconds after `run.completed`.

### Minimal change
1. **Backend (about 15 LOC):** in the web chat run thread, after `run_session_turn_sync` returns a `final_response`, call `maybe_auto_title(db, sid, user_message, final_response, conversation_history)`, the same way `gateway/run.py:18254-18268` does. Wrap it in try/except. It is already non-blocking. **Prompt-cache safe:** this is a separate aux call that only writes `sessions.title` and never touches the conversation's messages or system prompt.
2. **Client:** after `run.completed`, re-fetch the session row once after about 4 s, or use the next 15 s list poll. No new route.
3. **Optional:** add `title_source: "user" | "agent" | null` so the UI can mark agent-titled sessions (an "auto" hint plus one-click rename). This needs a `sessions.title_source` column, which can share the v19 migration with §c. *Skip it unless the design asks for it.*

**Effort:** 1 d, including a test against a temp `HERMES_HOME` and the agent-home flow.
**Risks:** an aux model call per new conversation costs money. `title_generation` is already the default for every other surface, and `auxiliary.title_generation.provider` can be set to a cheap model. There is a race if a user renames while generation is in flight; `auto_title_session` re-checks for an existing title before writing, but verify that.

---

## c. Pin / un-pin (per user, survives devices)

### What exists today
- No pin anywhere in `hermes_state.py`. Schema `SCHEMA_VERSION = 18` (`hermes_state.py:126`). v18 added `session_tags` / `session_tag_map` (`hermes_state.py:1865+`).
- The only "keep this near the top" mechanism is drag-reorder in `localStorage` (`agent-home/src/lib/chat/session-order.ts:11`, key `agent-home:session-order`, used by `SessionTabs.tsx:40-63` / `ChatPane.tsx:46`). It is per browser and does **not** survive devices.
- Per-user, box-wide preference storage already exists in `hermes_cli/user_prefs.py`: one JSON file per login, used by `GET/PUT /api/me/preferences` (`hermes_cli/web_server.py:3754`).

### Design choice
Sessions live in a **per-profile** `state.db`, and each session row has an owner (`user_id`). Because the owner is one person, a pin is effectively per user. Two options:

| Option | Pro | Con |
|---|---|---|
| **A. `session_pins` table in each profile's `state.db` (recommended)** | Joinable in `GET /api/sessions` (one query, sorting `pinned` first is trivial). Cleans up with the session. Works for shared or lead sessions because the key is `(user_id, session_id)` | Needs migration v19 |
| B. Pin list in `user_prefs` JSON | No migration | Needs a cross-profile id list, a second read, and manual cleanup on delete |

### Minimal change (Option A)
**Migration v19** (`hermes_state.py`, bump `SCHEMA_VERSION` to 19, add `if current_version < 19:` after the v18 block):
```sql
CREATE TABLE IF NOT EXISTS session_pins (
  user_id    TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  pinned_at  REAL NOT NULL,
  PRIMARY KEY (user_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_session_pins_user ON session_pins(user_id, pinned_at DESC);
```
`SessionDB.pin_session(user_id, sid)`, `unpin_session(...)`, `list_pins(user_id)`. Pin the **root** id (`resolve_resume_session_id`) so that compaction continuations stay pinned.

**Python endpoints:**
- `PUT /api/sessions/{id}/pin` and `DELETE /api/sessions/{id}/pin`. Same ownership check as `PATCH /api/sessions/{id}`.
- `GET /api/sessions` adds `pinned_at` to each row from a LEFT JOIN on the caller's `user_id`, plus a `pinned=only|first` query parameter (`first` sorts `pinned_at DESC` and then the existing order).

**BFF:** `POST /api/chat/sessions/pin {sessionId, pinned: boolean, profile?}`, modelled on `rename/route.ts`.
**Client:** `setSessionPinned(sessionId, pinned)`. `SessionSummary.pinned_at?: number | null`.
**Polling:** none. The list re-reads on focus, which also covers other devices.

```json
// PUT /api/sessions/20261101_.../pin  → 200
{ "session_id": "20261101_...", "pinned_at": 1762565400.0 }
// GET /api/sessions?order=recent&pinned=first&limit=30 → items[i]
{ "id": "20261101_...", "title": "Q4 supplier shortlist", "last_active": 1762560000, "pinned_at": 1762565400.0, "...": "..." }
```
**Cap:** 20 pins per user per profile (server-side 409). This keeps the landing area small.
**Effort:** 1.5 d. **Risks:** existing installs run the migration on first open (the pattern is proven by v18). A cross-profile "all pins" view needs one read per enrolled profile; the landing page only needs the current profile.

---

## d. Pin suggestions on page load (cheap, cache-safe)

### What exists today
- `POST /api/sessions/{id}/tags/suggest` (`hermes_cli/web_server.py:11823`) condenses one transcript and calls `_llm_tag_suggest` (DeepSeek or an OpenAI-compatible model, JSON-only). It handles one session at a time and is tag-oriented.
- `agent/auxiliary_client.py` `call_llm` with per-task provider/model config `auxiliary.<task>.{provider,model}` (`hermes_cli/config.py:1578+`). This is the right channel.
- Reusable signals: `SessionSummary.preview`, `message_count`, `last_active`, `is_active`, `archived`, tags, and the active run (`_CHAT_RUNS`, `web_server.py:12304`).

### Prompt-cache safety (AGENTS.md)
The review **never** adds a message to, rebuilds, or resumes any conversation. It is a **separate, stateless aux call** over a few metadata fields per session. The conversations' cached prefixes are untouched, so there is zero cache impact. Do not implement it as "ask the lead chat to review my sessions": that would add turns to the lead conversation and bloat its context.

### Minimal design
1. **Heuristic pre-filter (free, SQL only).** Look at sessions the caller owns from the last 14 days that are not archived, not pinned, not dismissed, and have `message_count ≥ 4`. Score them by:
   - the last message is from the user (unanswered), or the run errored or was interrupted;
   - the last assistant message ends with a question or contains "next step / TODO / let me know";
   - the session has a pending tool approval (§f);
   - recency and length.

   Keep the **top 8**. If none are left, return `[]` with no LLM call.
2. **One aux call** (`call_llm(task="session_review")`, defaulting to the same cheap model as `title_generation`). Input per candidate: `id, title, preview(≤200 chars), last user msg (≤300), last assistant msg (≤300), message_count, age`. That is about 2–3k tokens in total. Output is JSON: `[{id, reason ≤ 80 chars, unfinished: bool, score 0-1}]`. Keep items with score ≥ 0.6, at most 3.
3. **Cache:** a v19 table in the same migration as §c:
   ```sql
   CREATE TABLE IF NOT EXISTS session_pin_suggestions (
     user_id TEXT NOT NULL, session_id TEXT NOT NULL,
     reason TEXT, score REAL, fingerprint TEXT NOT NULL,   -- hash(last_active, message_count)
     status TEXT NOT NULL DEFAULT 'open',                  -- open | accepted | dismissed
     created_at REAL NOT NULL, decided_at REAL,
     PRIMARY KEY (user_id, session_id)
   );
   ```
   Also store `state_meta['pin_review:<user>'] = {ran_at, input_fingerprint}`. **Rerun only if** more than 6 h have passed **and** the candidate fingerprint set changed. Otherwise serve the cached rows. A dismissed suggestion stays dismissed until that session's fingerprint changes, meaning new messages. **Accept** means pin (§c) and set `status='accepted'`.
4. **When it runs:** `GET /api/sessions/pin-suggestions` returns cached rows straight away. If a rerun is due, it starts the aux call in a background thread and returns `{"pending": true}`. The client re-reads once after about 8 s. Page load is never blocked.

### API shapes
```json
// GET /api/sessions/pin-suggestions?profile=default
{
  "items": [
    { "session_id": "20261105_...", "title": "Supplier shortlist draft",
      "reason": "You asked for 3 more quotes; agent is waiting on your criteria",
      "unfinished": true, "score": 0.82, "last_active": 1762300000 }
  ],
  "pending": false, "reviewed_at": 1762560000
}
// POST /api/sessions/pin-suggestions/{session_id}  { "decision": "accept" | "dismiss" }
{ "session_id": "20261105_...", "status": "dismissed" }
// POST /api/sessions/pin-suggestions/dismiss-all → { "dismissed": 3 }
```
**BFF:** `GET/POST /api/chat/sessions/pin-suggestions`. **Client:** `pinSuggestions()`, `decidePinSuggestion(id, decision)`.
**Config:** `auxiliary.session_review.{provider,model}` and `landing.pin_suggestions: true` in `config.yaml`, not an env var.
**Effort:** 2.5 d. **Risks:** (1) privacy: transcript snippets go to the aux provider. This is the same exposure as title and tag generation, but put it behind the config flag and default it on only where `title_generation` is already enabled. (2) Nagging: limit to 3 suggestions and show them once per run; "dismiss all" suppresses them until new activity. (3) Cost: at most about 4 calls per user per day, each about 3k tokens.

---

## e. Active tasks/projects summary

### What exists today
| Piece | Location |
|---|---|
| Python `GET /api/activity/running` → `hermes_cli/activity_running.py`: `chat_items` (L72), `project_items` (L157; runs with `status IN ('running','waiting')` at L171, plus running cards L122), `cron_items` (L241), `finalize` (L291) | `hermes_cli/web_server.py:12611` |
| BFF `GET /api/activity/running` (`unstable_cache` 10 s, keyed by token hash and role; 502 when upstream fails so the client keeps stale data) | `agent-home/src/app/api/activity/running/route.ts` |
| `ActivityItem {kind: chat\|project_run\|card\|cron, id, name, started_at, href, profile, status: running\|waiting}` | `agent-home/src/types/index.ts:2945-2961` |
| Client `activityRunning()` | `client.ts:2015` |
| Projects list `GET /api/registry/projects?status=active` returns per item `progress`, `output_rollup` (incl. `awaiting_acceptance`), `health` (`attention`/`stalled`/…), `latest_run{run_no,status}`, `plan_pending` | `hermes_cli/projects_api.py:930-975`, client `projects()` `client.ts:1978` |
| Landing card already fetches `projects({status:"active", limit:5})` | `agent-home/src/app/page.tsx:48`, `components/projects/ProjectsHomeCard.tsx` |

### What is missing
Nothing blocks this. The data is complete for a summary of "N running · M waiting on you · K scheduled" plus a short list. Optional: one BFF route so the landing page makes a single request:
```json
// GET /api/landing/work  (BFF only; fans out to activityRunning() + projects({status:"active",limit:8}))
{
  "running": [ { "kind": "project_run", "name": "Weekly market brief #12", "status": "running", "started_at": 1762560000, "href": "/projects/market-brief/runs/12" } ],
  "projects": [ { "slug": "market-brief", "title": "Weekly market brief", "health": "attention", "progress": 0.6, "latest_run": { "run_no": 12, "status": "waiting" }, "awaiting_acceptance": 1 } ],
  "counts": { "running": 3, "waiting": 1, "cron_enabled": 4 },
  "collected_at": 1762560100
}
```
**Polling:** reuse the 15 s activity poll plus focus/visibility wakeups (`ActivityStrip.tsx` `POLL_MS = 15_000`). **Effort:** 0.5–1 d. **Risks:** the projects list computes health per project (`_full_health`), which costs O(projects). Keep `limit` small.

---

## f. Unified "needs you"

### Every waiting source found
| # | Source | Persisted where | Already in `NotificationStore`? | List read today | Answer action today |
|---|---|---|---|---|---|
| 1 | **Project run waiting at checkpoint** (`awaiting_continue`, `checkpoint_wait`) | `project_runs.status='waiting'` | ✅ via `raise_approval` (`projects_run.py:855`, callers L1024/1232/1615/2086, `projects_reconcile.py:316`) | run detail `projects_api.py:4100-4125`; activity `status:"waiting"` | `POST /api/registry/projects/{slug}/runs/{run_no}/continue` (`projects_api.py:4230`) or answer the notification |
| 2 | **Budget stop** | run + approval | ✅ `raise_approval(kind="budget")` `projects_run.py:1024` | same | answer notification |
| 3 | **Card waiting on a human** (`run_human_waits`) | kanban task state | ✅ `notify_waiting_on_you` (`projects_run.py:1607`, callers L1094/1778, `projects_reconcile.py:283`) | run payload `waiting_on_you` | unblock / answer |
| 4 | **Card approvals** (a worker asked `{key}`) | `task_approvals` (`kanban_db.py:1350`; `list_task_approvals` L3248) | ⚠️ not confirmed. Treat it as a separate source | board payload `pending_approvals` (`projects_api.py:2538,2832`) | `POST /{slug}/cards/{task_id}/approvals {key, decision}` (`projects_board_api.py:~276`) |
| 5 | **Blocked cards** | kanban `status='blocked'` | ❌ | board / `blocked_tasks` in run payload; UI `blockedCards()` `dashboard/derive.ts:102` | `POST /{slug}/cards/{task_id}/unblock` (`projects_board_api.py:222`) |
| 6 | **Outputs delivered, awaiting acceptance** | project outputs | ❌ | `output_rollup.awaiting_acceptance` (`projects_api.py:477-485`) | `POST /{slug}/outputs/{output_id}/accept` (`projects_api.py:2205`) |
| 7 | **Clarify questions open / plan awaiting approval** | clarify rounds; `plan_pending` | ❌ | `project.clarify.open_count` (`derive.ts:186`); list `plan_pending` | clarify routes `projects_clarify_api.py`; plan approve |
| 8 | **Other project "next actions"** (triage, scope, readiness, inputs) | derived only | ❌ | client-side `needsYouItems()` / `NEEDS_YOU_ORDER` (`dashboard/nextAction.ts:81,293,523`) | various |
| 9 | **Chat tool approvals** (dangerous command in an agent-home run) | **in-memory only**: `tools/approval.py:1636` `_gateway_queues[session_key]`, emitted as SSE `approval.request` (`web_server.py:12331-12440`) | ❌ | **none.** Only the open stream sees it | `POST /v1/runs/{run_id}/approval` (`web_server.py:12780`) |
| 10 | **Webview C6 per-action approvals** | `session.pending` in memory + a `kind="approval"` notification | ✅ (`web_server.py:5805-5820`) | notifications | `POST /api/webview/approval/{id}` (`web_server.py:5829`) |
| 11 | **Todos reaching `open`** | todo store, `tasks.notified_at` | ✅ as `proactive_ask` (`hermes_cli/todo_notifier.py`, `todos_cmd.py:467`) | `/api/registry/todos` (+ facets used by the MobileShell badge) | done / snooze (`todos_api.py:493`) |
| 12 | **Profile suggestions** (open card, at most 1) | `ProfileSuggestionStore` | ❌ | `GET /api/profiles/suggestions` (`web_server.py:16337`) | `POST .../{id}/adopt` (L16366) |
| 13 | Pin suggestions (§d) | new | n/a | §d | §d |

`NotificationStore` (`hermes_cli/human_comms.py`, kinds `("approval","proactive_ask")` L129) already applies quiet hours, rate limits, dedupe and cross-surface answer dedupe (contract C6). Python `GET /api/comms/notifications` (L5003) / `POST .../{id}/answer` (L5029), client `notifications()` `client.ts:1282`. **It already covers sources 1, 2, 3, 10 and 11.**

### Minimal change
**1. Python `GET /api/needs-you`** in a new module `hermes_cli/needs_you.py` (read-only fan-out, no new storage). It merges:
- `NotificationStore.list_pending(user)` → sources 1, 2, 3, 10, 11, mapped by `kind` and dedupe key;
- for each project the caller can read (reuse `_can_read` / the list path from `projects_api.py:930`): pending `task_approvals`, `blocked` cards, `output_rollup.awaiting_acceptance > 0`, `clarify.open_count > 0`, `plan_pending`. **Drop any item that already has a matching notification row**, using a `(project, task_id/run_no)` key;
- chat tool approvals: add `tools/approval.py::list_pending_for_user(user_id)`, which iterates `_gateway_queues` (entries already store `requester_user_id`) and maps `session_key` → `session_id`/`run_id` through `_CHAT_RUNS`;
- the profile suggestion when one is open.

Sort by `severity` (blocking > approval > review > fyi), then `created_at` ascending, so the oldest blocker comes first.

**2. Make chat approvals reach the user when the tab is closed:** in the web chat `_approval_notify` (`web_server.py:~12398`), also call `send_push(...)` with the same tag. It is best effort, like `_push_approval` (`projects_run.py:834`). Do **not** move the approval into `NotificationStore`: its lifecycle is the run and it disappears on `unregister_gateway_notify`.

**3. Optional backend change:** `include=count` returns `{count, by_severity}` only, for the 15 s badge poll.

### API shape
```json
// GET /api/needs-you            (BFF: GET /api/needs-you, unstable_cache 5 s keyed by token hash)
{
  "items": [
    {
      "id": "notif:9f2c…",                       // stable: "<source>:<native id>"
      "source": "project_checkpoint",            // project_checkpoint | budget | card_wait | card_approval | card_blocked | output_acceptance | clarify | plan_approval | chat_tool_approval | webview_approval | todo | profile_suggestion | pin_suggestion
      "severity": "blocking",                    // blocking | approval | review | fyi
      "title": "Weekly market brief #12 is paused at checkpoint 'Draft ready'",
      "detail": "Review the draft, then continue or stop.",
      "context": { "project_slug": "market-brief", "run_no": 12, "task_id": null, "session_id": null, "profile": "default" },
      "created_at": 1762559000,
      "href": "/projects/market-brief/runs/12",  // deep link (same builders as activity_running._project_href/_chat_href)
      "actions": [
        { "id": "continue", "label": "Continue", "style": "primary",
          "method": "POST", "endpoint": "/api/projects/market-brief/runs/12/continue", "body": {} },
        { "id": "open", "label": "Review", "style": "secondary", "href": "/projects/market-brief/runs/12" }
      ],
      "reversible": true,
      "notification_id": "9f2c…"                 // present when it came from NotificationStore → answering dedupes across surfaces
    },
    {
      "id": "chat_approval:run_ab12:0",
      "source": "chat_tool_approval", "severity": "blocking",
      "title": "Agent wants to run a command in 'Server cleanup'",
      "detail": "rm -rf ./build/cache  (redacted)",
      "context": { "session_id": "20261108_…", "run_id": "run_ab12", "profile": "default" },
      "created_at": 1762560050,
      "href": "/chat?session=20261108_…",
      "actions": [
        { "id": "once", "label": "Allow once", "style": "primary", "method": "POST", "endpoint": "/api/chat/approval", "body": { "runId": "run_ab12", "choice": "once" } },
        { "id": "deny", "label": "Deny", "style": "danger", "method": "POST", "endpoint": "/api/chat/approval", "body": { "runId": "run_ab12", "choice": "deny" } }
      ]
    }
  ],
  "count": 2,
  "by_severity": { "blocking": 2, "approval": 0, "review": 0, "fyi": 0 },
  "collected_at": 1762560100
}
```
Each `actions[].endpoint` points at an **existing BFF route** (verified: `api/projects/[slug]/runs/[runNo]/continue`, `api/projects/[slug]/cards/[taskId]/approvals`, `api/chat/approval` `{runId, choice: once|session|always|deny}`, `api/webview/approval/[approvalId]`), so the landing page calls what the project, inbox and chat UIs already call. Destructive or irreversible actions (`reversible:false`) are shown as `open` only: the user must go to the deep link and cannot one-tap them from the landing page.

**BFF:** `agent-home/src/app/api/needs-you/route.ts`, modelled on `activity/running/route.ts` (502 on failure → keep stale data). **Client:** `needsYou(opts?: {countOnly?: boolean})`. **Types:** `NeedsYouEntry`, `NeedsYouAction`, `NeedsYouResponse` in `types/index.ts`. Keep the existing `NeedsYouItem` (project dashboard) as it is.

### How the UI gets the user's attention
1. **Badge:** a count in the combined top bar (§g) and the coral/app badge (`badgeCounts` in `MobileShell`). Polled every 15 s while visible, and refreshed on focus/visibility, the same cadence as activity. `navigator.setAppBadge(count)` where supported; it is a no-op elsewhere.
2. **Banner:** when `by_severity.blocking > 0`, a sticky landing banner shows the oldest item and its primary action, plus "N more". It cannot be dismissed while blocking items remain, only collapsed.
3. **Title / favicon:** `document.title = "(2) Hermes"` while anything blocking is open.
4. **Web Push (tab closed):** already sent for project approvals (`projects_run.py:834` → `plugins/platforms/app/push.py:94 send_push`), and will be sent for chat approvals (change 2). Today `sw.js` shows the notification and focuses or navigates on click (`agent-home/public/sw.js:95-126`). Add `tag: item.id`, a de-dupe tag, to the payload; sw.js already reads `data.tag`. Enrolment stays an explicit user gesture (`components/push/PushEnroll.tsx`). The landing page shows a one-time "Get notified when something needs you" prompt that calls the same enrol flow. Never call `Notification.requestPermission()` without a click.
5. **Push-triggered refresh:** in sw.js `push`, `postMessage({type:"needs-you:refresh"})` to open clients so the badge updates immediately rather than on the next poll. That is 5 lines.

No SSE or websocket bus exists (no `EventSource` in `agent-home/src`), so polling plus push is the minimal design. A server-sent event stream is a later optimisation.

**Effort:** 3–4 d (aggregator 1.5, chat-approval listing + push 0.5, BFF/client/types 0.5, tests against a temp `HERMES_HOME` with a real project/kanban 1).
**Risks:** (1) Cost: fanning out over every readable project on each poll. Mitigate with the 5 s BFF cache, cheap aggregates only (`_card_rollup_sync` + `task_approvals` + rollup counts), and no `_full_health`. (2) Double counting between notifications and derived project state: dedupe by `(project, run_no|task_id)`. (3) Chat approvals are in memory, so a server restart loses them. That matches today's behaviour, because the run dies too. (4) Answering through the landing page must use the same `notification_id` answer path so C6 cross-surface dedupe still holds.

---

## g. Health top bar + activity bar

### What they have today
- **StatusStrip** (`agent-home/src/components/ui/StatusStrip.tsx`, `POLL_MS = 30_000`, refresh on focus/visibility) ← BFF `GET /api/status/summary` (`agent-home/src/app/api/status/summary/route.ts`, `unstable_cache` 15 s). Fields (`types/index.ts:2924-2942`): `cpu_pct, mem_pct, disk_pct, tokens_month, active_conversations, running_cards, cron_total, cron_enabled, build?, upload_storage?, collected_at`. It renders CPU, disk, monthly tokens/cost, tasks, cron, freshness, build mismatch and low storage.
- **ActivityStrip** (`ActivityStrip.tsx`, `POLL_MS = 15_000`, `LONG_RUN_MS = 30 min`) ← `/api/activity/running` (§e). It renders a scrollable chip row and nothing when empty.
- Both are mounted in `MobileShell.tsx:137-138` behind `showCoral`.

### Missing for a combined bar
| Need | Source | Change |
|---|---|---|
| "Needs you" count / severity | §f | `GET /api/needs-you?include=count` |
| One poll instead of two | — | BFF `GET /api/landing/bar` = `status/summary` ∪ `activity/running` ∪ needs-you count, 15 s. *Optional*: the two existing polls can also stay as they are |
| Health verdict (ok / degraded / down) instead of raw % | derive client-side from `cpu_pct/mem_pct/disk_pct/upload_storage/build` | none. Put the thresholds in one TS helper |
| Model/provider reachability | not collected | out of scope. Leave a placeholder |

```json
// GET /api/landing/bar  (BFF only)
{ "health": { "verdict": "ok", "cpu_pct": 22, "mem_pct": 61, "disk_pct": 48, "build_mismatch": false, "low_storage": false },
  "usage": { "tokens_month": 1830000 },
  "work": { "running": 3, "waiting": 1, "cron_enabled": 4 },
  "needs_you": { "count": 2, "blocking": 2 },
  "collected_at": 1762560100 }
```
**Effort:** 0.5 d (BFF + types). **Risks:** low. Keep the per-route 502-means-stale behaviour per section so one failing upstream does not blank the whole bar.

---

## Suggested build order after approval
1. b-fix (auto-title in web chat) and c (pins + v19 migration, including the `session_pin_suggestions` table). These have independent value and share one migration.
2. f (needs-you aggregator + chat approval push), the highest user value.
3. e + g (BFF composites).
4. d (pin suggestions), the most product-sensitive. Ship it behind `landing.pin_suggestions`.

## Open questions for the design
- Should the landing chat be **inline** (ChatPane `fill` mode on `/`) or a **launcher** that routes to `/chat`? This changes the UI only; the backend is the same either way.
- Should pins be scoped per profile (recommended, matches FG-28 islands) or be one global list across profiles?
- Which actions may be one-tap on the landing page? Proposal: reversible ones only, and anything with `reversible:false` deep-links.
