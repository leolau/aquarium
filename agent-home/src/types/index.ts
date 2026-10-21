/**
 * Shared TypeScript types for the `agent-home` seam (FG-20 Wave A2).
 *
 * These are the minimal, extendable shapes the Wave-B/C feature panels
 * consume. They intentionally mirror the Python-side records
 * (`hermes_cli/access.py`, `gts.py`, `interactions.py`) so the BFF and the
 * feature panels speak the same vocabulary as the AI layer + Supabase.
 *
 * They are deliberately *minimal*: only the fields Wave A needs to prove the
 * seam plus the core identifiers later waves will extend. Add fields as each
 * feature panel lands rather than front-loading a speculative surface.
 */

/** The four C1 roles (mirror of `access.Role`). */
export type Role = "owner" | "admin" | "member" | "viewer";

/**
 * The resolved C1 principal a request acts under (mirror of
 * `access.Principal`). This is what the auth bridge establishes and what the
 * server-side Supabase context binds into the `hermes.principal_*` GUCs.
 */
export interface Principal {
  user_id: string;
  display: string;
  role: Role;
  channels: string[];
  is_owner: boolean;
}

/** C3 datastore mode — selects the `app_dev` / `app_prod` schema. */
export type StoreMode = "dev" | "prod";

/** Visibility tag on every scoped row: `shared` or `private:<user_id>`. */
export type Visibility = "shared" | `private:${string}`;

/**
 * How a node's progress is observed/scored (mirror of
 * `gts` evaluation-method dict). The score itself is always engine-computed;
 * this is the user-owned observe/measure definition, never the score.
 */
export interface GtsObservation {
  source: string;
  prompt: string;
  ref?: Record<string, unknown>;
}

export interface GtsEvaluationMethod {
  set_by_user_id: string | null;
  locked: boolean;
  measurable: boolean;
  observation: GtsObservation | null;
  scoring_prompt: string;
}

/**
 * A FG-19 per-item grant attached to a node: the single `assignee` plus any
 * read-only `watcher`s. A grant only confers access while `pending`/`accepted`.
 */
export interface GtsItemGrant {
  id: string;
  item_kind: string;
  item_id: string;
  user_id: string;
  grant: "assignee" | "watcher" | string;
  granted_by: string;
  status: string;
}

/** A GTS goal node (mirror of `gts.GtsGoal.as_dict` + graph enrichment). */
export interface GtsGoal {
  id: string;
  owner_user_id: string;
  visibility: string;
  title: string;
  priority: string;
  status: string;
  level: string;
  parent_goal_id: string | null;
  score: number | null;
  assignee_user_id: string | null;
  evaluation_method: GtsEvaluationMethod;
  grants: GtsItemGrant[];
}

/** A GTS task node (mirror of `gts.GtsTask.as_dict` + graph enrichment). */
export interface GtsTask {
  id: string;
  owner_user_id: string;
  visibility: string;
  title: string;
  priority: string;
  status: string;
  current_state: string;
  parent_task_id: string | null;
  score: number | null;
  assignee_user_id: string | null;
  evaluation_method: GtsEvaluationMethod;
  grants: GtsItemGrant[];
}

/** A GTS skill node (mirror of `gts` skill dict). */
export interface GtsSkill {
  id: string;
  owner_user_id: string;
  visibility: string;
  name: string;
  skill_ref: string;
}

/** Either kind of GTS graph node. */
export type GtsNode =
  | ({ kind: "goal" } & GtsGoal)
  | ({ kind: "task" } & GtsTask);

/**
 * The full C2-scoped GTS graph the Python API returns from `/api/gts/graph`:
 * goal→task→skill hierarchy with the M:N edges, engine-computed scores, and
 * FG-19 assignment. `configured: false` when the app datastore is unset.
 */
export interface GtsGraphResponse {
  configured: boolean;
  principal?: string | null;
  mode?: string;
  goals: GtsGoal[];
  tasks: GtsTask[];
  skills: GtsSkill[];
  task_goals: { task_id: string; goal_id: string }[];
  task_skills: { task_id: string; skill_id: string }[];
  assignment: { enabled: boolean; scheme: string };
}

/** The C8 interaction/trace kinds (mirror of `interactions.InteractionKind`). */
export type InteractionKind =
  | "inbound"
  | "turn"
  | "tool_call"
  | "tool_result"
  | "outbound"
  | "approval"
  | "change"
  | "cost"
  | "error"
  | "core_denied";

/** A single C8 interaction-trace row (mirror of `interactions.Interaction`). */
export interface TraceRow {
  id: string;
  trace_id: string;
  parent_id: string | null;
  ts: string;
  actor_user_id: string;
  session_key: string;
  platform: string;
  kind: InteractionKind;
  ref: string;
  summary: string;
  payload_ref: string | null;
  mode: string;
}

/**
 * A C8 trace summary row (mirror of `interactions.TraceSummary.as_dict`): one
 * conversation/trace rolled up to its span, event count, and per-kind counts.
 */
export interface TraceSummary {
  trace_id: string;
  first_ts: string;
  last_ts: string;
  actor_user_id: string | null;
  session_key: string | null;
  platform: string | null;
  mode: string;
  event_count: number;
  kind_counts: Record<string, number>;
  rolled_up: boolean;
}

/** The C2-scoped list of C8 traces from `/api/comms/traces`. */
export interface TracesResponse {
  configured: boolean;
  principal?: string | null;
  traces: TraceSummary[];
}

/**
 * One trace's timeline projection from `/api/comms/traces/{id}`: the ordered
 * interaction events plus the rolled-up summary (null while still live).
 */
export interface TraceDetailResponse {
  configured: boolean;
  principal?: string | null;
  trace_id: string;
  interactions: TraceRow[];
  rollup: TraceSummary | null;
}

/**
 * A FG-12 change-log row (mirror of the `/api/comms/changes` payload): an
 * agent/human mutation the principal may review, and whether it's reversible.
 */
export interface Change {
  id: string;
  actor_user_id: string | null;
  mode: string;
  target_kind: string;
  reversible: boolean;
  visibility: string;
  undone: boolean;
}

/** The C2-scoped FG-12 change log from `/api/comms/changes`. */
export interface ChangesResponse {
  configured: boolean;
  principal?: string | null;
  changes: Change[];
}

/**
 * A durable Core-write denial (mirror of a `core_audit_log` line): an agent
 * write refused at the C7 boundary. Surfaced by the Core-area view.
 */
export interface CoreDenial {
  id: string;
  ts: number;
  actor_user_id: string;
  mode: string;
  summary: string;
  op?: { kind?: string; op?: string; path?: string; matched_glob?: string };
}

/**
 * The FG-14 C7 Core-boundary projection from `/api/core/manifest` (read-only):
 * the active `core_manifest.yaml` globs, boundary health (`fallback_active`
 * means it's running on the baked-in fail-closed set), and a tail of the
 * durable Core-denial audit log. Core is immutable to the runtime agent.
 */
export interface CoreManifestResponse {
  core_root: string;
  manifest_path: string;
  manifest_present: boolean;
  manifest_parseable: boolean;
  fallback_active: boolean;
  self_protected: boolean;
  globs: string[];
  glob_count: number;
  audit_log_path: string;
  denials: CoreDenial[];
}

/**
 * A single FG-15 onboarding-readiness check (mirror of the CLI setup schema):
 * whether a required/optional prerequisite is `met`, why it matters, and the
 * `hermes …` fix command. Reports secret *presence* only, never values.
 */
export interface OnboardingItem {
  key: string;
  label: string;
  required: boolean;
  rationale: string;
  fix_command: string;
  contract: string;
  met: boolean;
  detail: string;
}

/**
 * The FG-15 onboarding readiness from `/api/onboarding/readiness`: the overall
 * score + `ready_for_prod` gate the CLI computes, plus the per-item checks.
 */
export interface OnboardingReadinessResponse {
  score: number;
  score_pct: number;
  ready_for_prod: boolean;
  required_total: number;
  required_met: number;
  optional_total: number;
  optional_met: number;
  optional_coverage: number;
  missing_required: string[];
  items: OnboardingItem[];
}

/** A registry tool's provenance kind (mirror of the Python tools registry). */
export type ToolKind = "in_house" | "remote" | "builtin";
/** A registry tool's enable status. */
export type ToolStatus = "enabled" | "disabled";

/**
 * A FG-07 tool-registry entry (mirror of `tools_registry.Tool.as_dict`): a
 * tool the operator may enable/promote. This surface is read-only in
 * `agent-home` — enable/config/promote stay on the operator authority paths.
 */
export interface Tool {
  id: string;
  name: string;
  kind: ToolKind;
  stack: string;
  owner_user_id: string;
  visibility: string;
  mode: StoreMode;
  status: ToolStatus;
  enabled: boolean;
  mcp_endpoint_ref: string | null;
  web_url: string | null;
  config_json: Record<string, unknown>;
}

/** The C2-scoped tool registry from `/api/tools` for a datastore mode. */
export interface ToolsResponse {
  configured: boolean;
  mode: StoreMode;
  tools: Tool[];
  detail?: string;
}

/** A chat message role in a one-brain conversation (mirror of the store). */
export type ChatRole = "user" | "assistant" | "system" | "tool";

/**
 * A single persisted conversation message (mirror of the `messages` row the
 * Python `SessionDB` returns). Only the fields the mobile chat pane renders are
 * typed; `tool` rows are kept out of the visible thread.
 */
export interface ChatMessage {
  id?: number;
  role: ChatRole;
  content: string;
  timestamp?: number | string | null;
  /** Persisted extended-thinking text (SessionDB `reasoning` column). */
  reasoning?: string | null;
  /** Stable React key for an optimistic row that has no DB id yet. */
  clientKey?: string;
}

/**
 * A conversation summary row (mirror of `SessionDB.list_sessions_rich`): the
 * id, its human title/preview, message count, and last-active timestamp used to
 * order the mobile conversation list.
 */
/** A tag attached to a session (mirror of `session_tags` table). */
export interface SessionTag {
  id: string;
  name: string;
  color: string;
  session_count?: number;
}

/** An LLM-produced tag suggestion awaiting user confirmation. */
export interface TagSuggestion {
  tag_name: string;
  is_new: boolean;
  reason?: string;
  confidence?: number;
}

export interface SessionSummary {
  id: string;
  source: string;
  title: string | null;
  preview: string | null;
  message_count: number;
  started_at: number | null;
  last_active: number | null;
  ended_at: number | null;
  is_active?: boolean;
  archived?: boolean;
  /** The working directory the session ran in (already returned by the
   * Python API's `SELECT s.*`, just not previously typed here). Used to
   * detect kanban-card-worker sessions — see `lib/chat/categorize.ts`. */
  cwd?: string | null;
  /** Persisted token totals from the sessions table (used by context-window UI). */
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
  /** Tags assigned to this session (populated by tag endpoints). */
  tags?: SessionTag[];
}

/** The list of conversations from `GET /api/sessions`. */
export interface SessionsResponse {
  sessions: SessionSummary[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * One profile this box serves, from `GET /api/profiles` (FG-28). A profile is
 * an independent `HERMES_HOME` — its own SOUL, goal, skills, memory, sessions
 * and credentials — so selecting one changes which brain answers a turn.
 */
export interface ProfileSummary {
  name: string;
  is_default: boolean;
  description: string;
}

export interface ProfilesResponse {
  profiles: ProfileSummary[];
}

/**
 * FG-30 — a profile suggestion: a proposal (with evidence) that work in one
 * profile has clustered into a distinct sub-goal deserving its own profile.
 *
 * `evidence` is the JSONB the suggestion was raised on, returned verbatim
 * by the Python API. Per §4.2 T3 Q1 the aux-LLM prompt no longer carries the
 * roster, but the stored blob still does; a renderer must not surface it raw
 * (see the suggestion queue screen, which renders the prompt slice).
 */
export interface ProfileSuggestion {
  id: string;
  proposed_name: string;
  proposed_role: string;
  proposed_goal: string;
  parent_goal_id: string | null;
  rationale: string;
  evidence: Record<string, unknown>;
  dedup_key: string;
  origin_profile: string;
  status: "proposed" | "adopted" | "dismissed";
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string | null;
}

/**
 * A reviewed suggestion as the trail renders it. Deliberately narrower than
 * `ProfileSuggestion`: no `evidence`, because that blob carries the
 * `participants` roster (§4.2 T3) and the trail shows status, role and goal.
 */
export interface ProfileSuggestionSummary {
  id: string;
  proposed_name: string;
  proposed_role: string;
  proposed_goal: string;
  status: "proposed" | "adopted" | "dismissed";
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string | null;
}

export interface ProfileSuggestionsResponse {
  /** The open card — at most one (§1.1), with its evidence. */
  suggestions: ProfileSuggestion[];
  /** A capped trail of decisions already made, without evidence. */
  reviewed: ProfileSuggestionSummary[];
}

/** Owner-only adoption returns the new profile's path and goal (§3). */
export interface ProfileSuggestionAdoptResponse {
  ok: boolean;
  name: string;
  path: string;
  goal: string;
}

export interface ProfileSuggestionDismissResponse {
  ok: boolean;
  name: string;
}

/** One conversation's persisted transcript from `GET /api/sessions/{id}/messages`. */
export interface ChatMessagesResponse {
  session_id: string;
  messages: ChatMessage[];
  /** Present on a paged (`limit`) read: older rows exist on the server. */
  has_more?: boolean;
}

/** Token accounting a one-brain turn reports (mirror of the agent usage dict). */
export interface ChatUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

/**
 * The reply from `POST /api/sessions/{id}/chat`: the (possibly resumed) session
 * id the turn landed on, the assistant message, and optional usage.
 */
export interface ChatSendResponse {
  session_id: string;
  message: ChatMessage;
  usage?: ChatUsage;
}

/**
 * A pending tool-approval prompt surfaced mid-turn on the chat stream (the
 * `approval.request` event from `POST /api/sessions/{id}/chat/stream`). A tool
 * matched by `approvals.tools` blocks the agent turn until the user resolves
 * this via `POST /api/chat/approval` with one of `choices`. `command` is
 * already secret-redacted server-side.
 */
export interface ChatApprovalRequest {
  runId: string;
  toolName?: string;
  command?: string;
  description?: string;
  patternKey?: string;
  choices: string[];
}

/** The result of creating a conversation via `POST /api/sessions`. */
export interface SessionCreateResponse {
  session_id: string;
  source: string;
}

/**
 * A media attachment uploaded server-side to principal-scoped Supabase Storage
 * (browser never holds the storage key). The bucket is **private**, so only the
 * durable object `path` is carried: reads are re-signed on demand through the
 * BFF media route after a server-side ownership check (PR-5). There is
 * deliberately no `url` field — a stored URL would either be public or expired.
 */
export interface ChatAttachment {
  path: string;
  name: string;
  content_type: string;
  size: number;
}

/**
 * The per-attachment payload the BFF forwards to the Python chat endpoints so
 * the brain can actually read an upload. The transcript keeps only the durable
 * object `path` ({@link ChatAttachment}); this adds a short-lived signed `url`
 * the server uses once to download the bytes into the shared document cache.
 * It is never persisted or sent to the browser.
 */
export interface AgentAttachmentPayload {
  name: string;
  content_type: string;
  size: number;
  url: string;
}

/** Response of `GET /api/chat/media?path=…` — a short-lived signed read URL. */
export interface ChatMediaUrlResponse {
  path: string;
  url: string;
  expires_in: number;
}

/** Whether a comms item is a consent **approval** (grant/deny) or a proactive **ask** (acknowledge). */
export type NotificationKind = "approval" | "ask";

/** A comms item's settlement state (mirror of `human_comms.NotificationStatus`). */
export type NotificationStatus = "pending" | "answered" | "expired";

/**
 * A FG-10 human-comms item (mirror of `human_comms.Notification.as_dict`): a
 * pending approval or proactive ask visible to the principal (C2-scoped),
 * de-duplicated across surfaces (web/Telegram).
 */
export interface Notification {
  id: string;
  kind: NotificationKind;
  owner_user_id: string;
  visibility: Visibility;
  title: string;
  body: string;
  command: string;
  reversible: boolean;
  status: NotificationStatus;
  answer: string | null;
  answered_by: string | null;
  answered_via: string | null;
  delivered: boolean;
  created_at: string | null;
  answered_at: string | null;
}

/** The C2-scoped FG-10 notifications inbox from `/api/comms/notifications`. */
export interface NotificationsResponse {
  configured: boolean;
  principal?: string | null;
  notifications: Notification[];
}

/**
 * `POST /api/comms/notifications/{id}/answer`: the settled item plus whether
 * *this* surface was the one that settled it (`newly_answered` is false when
 * another surface, e.g. Telegram, answered first).
 */
export interface NotificationAnswerResponse {
  ok: boolean;
  newly_answered: boolean;
  notification: Notification;
}

/** `POST /api/comms/changes/{ref}/{undo|redo}`: the reverted/reapplied change. */
export interface ChangeOpResponse {
  ok: boolean;
  change_ref: string;
  target_kind: string;
}

/**
 * Where an invitation stands (mirror of `invitations.Invitation.status`). The
 * raw token is deliberately absent from this shape — it exists exactly once, in
 * the create/regenerate response, and is stored only as a hash.
 */
export type InvitationStatus = "open" | "used" | "revoked" | "expired";

/** An activation/recovery link's lifecycle (mirror of `Invitation.as_dict`). */
export interface Invitation {
  id: string;
  user_id: string;
  kind: "activation" | "recovery";
  status: InvitationStatus;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
  created_by: string;
  created_at: string;
}

/**
 * A user in this profile (mirror of `members.MemberView.as_dict`): an enrolled
 * principal joined with its Supabase (GoTrue) account state.
 *
 * The two "active" notions are genuinely different and both matter in the UI:
 * `active` is the **box-wide account** (false while banned — which is how a
 * created-but-not-yet-activated user looks), while `enrolled` is this
 * **profile's** enrolment (`principals.active`). Somebody can be a live account
 * elsewhere on the box and a suspended enrolment here.
 */
export interface Member {
  user_id: string;
  display: string;
  role: Role;
  email: string;
  active: boolean;
  enrolled: boolean;
  channels: string[];
  is_owner: boolean;
  invitation: Invitation | null;
}

/** `GET /api/comms/members`: one page of the roster (owner/admin only). */
export interface MembersResponse {
  configured: boolean;
  members: Member[];
  total: number;
  limit: number;
  offset: number;
  /** The profile this console administers (FG-27 derives its schema). */
  profile?: string;
}

/** What any enrolled principal may see about a colleague (FG-26 §3.1). */
export interface DirectoryEntry {
  user_id: string;
  display: string;
  role: Role;
  channels: string[];
}

/** `GET /api/comms/directory`: the colleague list, visible to everyone here. */
export interface DirectoryResponse {
  configured: boolean;
  entries: DirectoryEntry[];
  total: number;
  profile?: string;
}

/**
 * `POST /api/comms/members`: a new account (with its one-time activation link)
 * or an enrolment of an account that already existed on the box.
 *
 * `activation_path` is present only for a genuinely new account and only in
 * this response — somebody who already had an account already has a password,
 * and a link that could be re-fetched would not be single-use.
 */
export interface MemberCreateResponse {
  ok: boolean;
  enrolled_existing: boolean;
  member: { user_id: string; display: string; role: Role; email: string };
  invitation: Invitation | null;
  activation_path: string | null;
}

/** `POST /api/comms/members/{id}/invitation`: a freshly minted link, once. */
export interface MemberInvitationResponse {
  ok: boolean;
  invitation: Invitation;
  activation_path: string;
}

/** One CSV row's outcome (mirror of `members.ImportRow.as_dict`). */
export interface MemberImportRow {
  line: number;
  email: string;
  display: string;
  role: Role;
  planned: string;
  user_id: string;
  error: string;
  activation_path: string | null;
}

/** `POST /api/comms/members/import`: a preview, or what was applied. */
export interface MemberImportResponse {
  ok: boolean;
  dry_run: boolean;
  rows: MemberImportRow[];
  total: number;
  failed: number;
}

/** `PUT /api/comms/members/{id}/role`: the re-roled member. */
export interface MemberRoleResponse {
  ok: boolean;
  member: { user_id: string; role: Role };
}

/** `PUT /api/comms/members/{id}/display`: the renamed member. */
export interface MemberDisplayResponse {
  ok: boolean;
  member: { user_id: string; display: string };
}

/** `POST /api/comms/members/{id}/channels`: the member's linked handles. */
export interface MemberChannelsResponse {
  ok: boolean;
  member: { user_id: string; channels: string[] };
}

/** `DELETE /api/comms/members/{id}`: what happened to the rows they owned. */
export interface MemberDeleteResponse {
  ok: boolean;
  user_id: string;
  strategy: "transfer" | "purge";
  rows_transferred: number;
  rows_deleted: number;
}

/** One identity-administration event from the C5 log (never a raw token). */
export interface IdentityEvent {
  change_ref: string;
  actor_user_id: string;
  action: string;
  user_id: string;
  payload: Record<string, unknown>;
}

/** `GET /api/comms/members/activity`: recent identity events (owner/admin). */
export interface IdentityActivityResponse {
  configured: boolean;
  events: IdentityEvent[];
}

/** Generic ack for the (de)activation member mutations. */
export interface MemberOkResponse {
  ok: boolean;
  active?: boolean;
}

/**
 * FG-17b agent-webview consent grant (mirror of `webview.WebviewScope`): the
 * domains the agent may act on and whether interactive actions are allowed.
 */
export type WebviewMode = "read_only" | "interactive";

export interface WebviewScope {
  allowed_domains: string[];
  mode: WebviewMode;
}

/**
 * An agent action verb requested against the live page (mirror of
 * `webview.ActionKind`). Read-only kinds run autonomously in scope; interactive
 * kinds need an `interactive` grant; `submit`/`download` always escalate.
 */
export type WebviewActionKind =
  | "navigate"
  | "read"
  | "screenshot"
  | "scroll"
  | "click"
  | "type"
  | "select"
  | "submit"
  | "download";

/** The Option-B policy decision for one webview action (mirror of `webview.Decision`). */
export type WebviewDecision = "allow" | "escalate" | "deny";

/**
 * A queued per-action C6 approval (mirror of `webview.PendingApproval.as_dict`):
 * an escalated action awaiting the user's grant/deny.
 */
export interface WebviewPendingApproval {
  id: string;
  kind: WebviewActionKind;
  url: string | null;
  credentialed: boolean;
  destructive: boolean;
  reason: string;
  created_at: number;
  resolved: boolean | null;
}

/**
 * One user's opted-in webview session (mirror of `webview.WebviewSession.as_dict`):
 * the consent scope, the C8 trace id grouping its actions, and any pending
 * approvals. Ephemeral + per-principal (the C2 isolation boundary).
 */
export interface WebviewSession {
  id: string;
  owner_user_id: string;
  scope: WebviewScope;
  profile_dir: string;
  created_at: number;
  trace_id: string;
  pending: WebviewPendingApproval[];
}

/**
 * `GET/POST /api/webview/session`: the caller's open session (or `null` for the
 * default-deny empty state). `configured: false` when the datastore is unset.
 */
export interface WebviewSessionResponse {
  configured: boolean;
  principal?: string | null;
  session: WebviewSession | null;
}

/**
 * The result of requesting/resolving a webview action
 * (`POST /api/webview/action` + `/approval/{id}`): the policy decision, its
 * reason, the CDP execution detail (when it ran), and the escalated approval
 * (when it queued).
 */
export interface WebviewActionResponse {
  decision: WebviewDecision;
  reason: string;
  executed?: boolean;
  detail?: string;
  granted?: boolean;
  approval?: WebviewPendingApproval;
}

// ---------------------------------------------------------------------------
// FG-23 — Memory explorer (read-only). Mirrors `hermes_cli/memory_explorer.py`
// exactly so the BFF, the Python API and the dashboard surface speak the same
// vocabulary. These shapes are lifted from `web/src/screens/MemoryPage.tsx`
// without field-name "improvements" — the API is the contract.
// ---------------------------------------------------------------------------

/** Embedding-space health (mirror of `PgvectorMemoryStore.describe_space()`). */
export interface MemorySpace {
  column_dim: number | null;
  rows_by_model: Record<string, number>;
  configured_model: string;
  healthy: boolean;
}

/** The `/api/memory/explorer/summary` response (C2-scoped counts + recall use). */
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

/** A single memory row from `/api/memory/explorer/rows`. */
export interface MemoryRow {
  id: string; owner_user_id: string; visibility: string; kind: string;
  topic: string | null; text: string; truncated: boolean;
  created_at: string | null; uses: number; last_used: string | null;
  elevated: boolean; provenance: string; score: number | null;
  // Citation fields — where this row came from. `source_session` is set on
  // memories written during a chat; the document fields are set on
  // `kind === "chunk"` rows, which come from an ingested file or Drive doc.
  source_session?: string | null;
  document_id?: string | null;
  document_title?: string | null;
  section?: string | null;
  source_kind?: string | null;
  source_ref?: string | null;
  ordinal?: number;
  file_asset_id?: string | null;  // set when this chunk's document was ingested from a registered file
}

/** Paginated rows response. */
export interface MemoryRowsResponse {
  rows: MemoryRow[]; total: number; limit: number; offset: number;
}

/** One point on the fitted 2-D map. */
export interface MemoryProjectionPoint {
  id: string; x: number; y: number; owner_user_id: string;
  topic: string | null; kind: string; elevated: boolean;
  provenance: string; label: string;
  // Same citation fields as `MemoryRow`, so a clicked dot can say where it
  // came from without a second fetch.
  source_session?: string | null;
  document_id?: string | null;
  document_title?: string | null;
  section?: string | null;
  source_kind?: string | null;
  source_ref?: string | null;
  file_asset_id?: string | null;  // set when this point's chunk was ingested from a registered file
}

/** The `/api/memory/explorer/projection` response. */
export interface MemoryProjection {
  algorithm: string | null;        // "pca" | "umap" | null when never fitted
  computed_at: string | null;
  stale: boolean;                  // model mismatch OR unprojected rows
  unprojected_count: number;
  points: MemoryProjectionPoint[];
  sampled?: boolean;               // true when the point set was deterministically downsampled
  total_points?: number;           // the unsampled count, present when sampled
}

/** The `/api/memory/explorer/projection/query` response. */
export interface MemoryQueryPlacement {
  x: number | null; y: number | null;                    // null ⇒ no position
  nearest: { id: string; score: number }[];
  degraded?: boolean;                                    // UMAP basis unloadable
}

/** A RAG document from `/api/memory/explorer/documents`. */
export interface MemoryDocument {
  id: string; owner_user_id: string; visibility: string; source_kind: string;
  source_ref: string; title: string; chunk_count: number;
  ingested_at: string | null;
  file_asset_id?: string | null;  // set when this document was ingested from a registered file
}

/** Paginated documents response. */
export interface MemoryDocumentsResponse {
  documents: MemoryDocument[]; total: number;
}

/**
 * A registered inbound file from `/api/registry/files` — one arrival, with the
 * provenance the receiving surface knew and nothing downstream does.
 *
 * `remembered` is the deliberate split from memory: a file is stored on
 * arrival, but only appears in the RAG corpus once somebody decided it matters
 * (`document_id` set, `remembered_by` naming the user or the triage skill).
 */
export interface FileAsset {
  id: string;
  owner_user_id: string;
  visibility: string;
  surface: string;                 // agent_home | telegram | whatsapp | email | calendar | …
  account_id: string | null;       // the receiving inbox/bot identity
  conversation: string | null;     // chat/thread/event this arrived in
  sender_id: string | null;
  sender_name: string | null;
  message_id: string | null;
  received_at: string | null;
  filename: string;
  content_type: string;
  byte_size: number;
  sha256: string;
  storage_path: string;            // an object key, never a path on the box
  document_id: string | null;
  remembered_at: string | null;
  remembered_by: string | null;
  remembered: boolean;
  /** The inbound item this file arrived with (for the /todos back-link). */
  inbound_item_id?: string | null;
}

/** Paginated registry listing. */
export interface FileAssetsResponse {
  files: FileAsset[];
  total: number;
  limit: number;
  offset: number;
}

/** Surfaces the caller actually has files from, for the filter chips. */
export interface FileSurfacesResponse {
  surfaces: { surface: string; count: number }[];
}

/** One arrival in the unified inbox: a WhatsApp message, an email, a meeting. */
export interface IncomingItem {
  id: string;
  owner_user_id: string;
  visibility: string;
  surface: string;                 // whatsapp | email | calendar | telegram | …
  account_id: string | null;       // the receiving inbox/number/calendar
  external_id: string;             // the channel's own id, stable across re-polls
  kind: string;                    // message | event | …
  conversation: string | null;
  conversation_name: string | null;
  sender_id: string | null;
  sender_name: string | null;
  subject: string | null;
  body: string;
  occurred_at: string | null;
  ends_at: string | null;          // calendar arrivals only
  registered_at: string | null;
  importance: string | null;
  has_attachments: boolean;
  metadata: Record<string, unknown>;
  document_id: string | null;
  remembered_at: string | null;
  remembered_by: string | null;
  remembered: boolean;
  tags?: SessionTag[];
}

/** A file that arrived with an item, as returned on the detail route. */
export interface IncomingAttachment {
  id: string;
  filename: string;
  content_type: string;
  byte_size: number;
  document_id: string | null;
  remembered: boolean;
}

/** An item plus what it carried. */
export interface IncomingDetail extends IncomingItem {
  attachments: IncomingAttachment[];
}

/**
 * A keyset page. `next_cursor` is null at the end, and there is deliberately
 * no total: counting the filtered set per page is the scan keyset paging
 * exists to avoid.
 */
export interface IncomingsResponse {
  items: IncomingItem[];
  next_cursor: string | null;
}

/** What the filter chips can offer without leading to an empty list. */
export interface IncomingsFacets {
  surfaces: { value: string; count: number }[];
  importance: { value: string; count: number }[];
  tags: SessionTag[];
}

/**
 * The user-facing lifecycle of a to-do. `staged` is the tier that does *not*
 * notify — captured, visible, silent — which is the whole reason it exists;
 * `open` is what the agent decided is worth an interruption.
 */
export type TodoStage = "staged" | "open" | "working" | "done" | "dismissed";

export type TodoPriority = "critical" | "high" | "normal" | "low";

/**
 * A to-do. Stored as an FG-06 `tasks` row, which is why `status`, `origin`
 * and the three state columns come along: the to-do IS the task, extended,
 * not a copy of it in a second table.
 */
export interface Todo {
  id: string;
  owner_user_id: string;
  visibility: string;
  title: string;
  description: string;
  stage: TodoStage;
  status: string;                  // FG-06 status, kept in lockstep with stage
  priority: TodoPriority;
  origin: string;                  // explicit | discovered | triage
  current_state: string;
  trigger_state: string;
  completion_state: string;
  due_at: string | null;
  source_kind: string | null;      // inbound | analysis | user | agent | cron
  source_ref: string | null;       // the inbound_items row, when it has one
  source_note: string | null;      // provenance when the arrival is unlinked
  notified_at: string | null;
  snoozed_until: string | null;
  closed_at: string | null;
  outcome: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/** One recorded move along the lifecycle, from `task_transitions`. */
export interface TodoTransition {
  from: string;                    // e.g. "stage:staged"
  to: string;                      // e.g. "stage:open"
  at: string | null;
  actor: string;                   // "user:leo", "skill:email-triage", …
}

/**
 * A to-do plus why it exists. `source` is the arrival that caused it, when it
 * is still resolvable — "why is this here?" is the first question a user asks
 * of anything an agent put in front of them.
 */
export interface TodoDetail extends Todo {
  history: TodoTransition[];
  source: IncomingItem | null;
  /** The memory document the source arrival produced (absent when not remembered). */
  memory?: { id: string; title: string };
}

/** A keyset page of to-dos. `next_cursor` is null at the end. */
export interface TodosResponse {
  items: Todo[];
  next_cursor: string | null;
}

/**
 * The redacted HTTP view of one unified-credential-store entry
 * (docs/design/unified-credential-store.md). Secret payload fields are
 * stripped server-side; what remains is safe to render in Settings.
 */
export interface CredentialEntry {
  owner_user_id: string;
  provider: string;
  name: string;
  kind: string;
  visibility: string;
  services: string[];
  payload: Record<string, unknown>;
  created_at: string | null;
  updated_at: string | null;
}

/** Payload of a `fortinet-vpn` credential (Settings → In&Out → Private
 *  networks). `password` / `share_password` are secret: never returned, and
 *  omitted or empty on PUT of an existing entry keeps the stored value. */
export interface FortinetVpnPayload {
  host: string;
  username: string;
  password?: string;
  port?: number;
  realm?: string;
  trusted_cert?: string;
  routes?: string[];
  share_path?: string;
  share_username?: string;
  share_password?: string;
  share_domain?: string;
  auto_connect?: boolean;
  idle_minutes?: number;
}

export type VpnState =
  | "connected"
  | "connecting"
  | "disconnected"
  | "error"
  | "needs_cert";

/** The gateway certificate shown for approval when `state == "needs_cert"`. */
export interface VpnCert {
  subject: string | null;
  issuer: string | null;
  not_after: string | null;
  sha256: string;
}

export interface VpnLastCheck {
  at: string;
  ok: boolean;
  message: string;
  file_count: number | null;
}

export interface VpnStatus {
  state: VpnState;
  since: string | null;
  local_ip: string | null;
  error: string | null;
  /** Set while connected when the VPN's own file share failed to mount. */
  share_error?: string | null;
  last_used: string | null;
  last_check: VpnLastCheck | null;
  cert?: VpnCert | null;
}

/** One saved Fortinet VPN as returned by Hermes `/api/vpn` (no secrets). */
export interface VpnView {
  name: string;
  slug: string;
  host: string;
  port: number;
  realm: string | null;
  routes: string[];
  share_path: string | null;
  mount_path: string | null;
  auto_connect: boolean;
  idle_minutes: number;
  visibility: string;
  owner_user_id: string;
  trusted_cert: string | null;
  status: VpnStatus;
}

/** Last "Save & test" / Test result for a network folder. */
export interface NetworkFolderLastCheck {
  at: string;
  ok: boolean;
  file_count: number | null;
  message: string;
}

export interface NetworkFolderStatus {
  vpn_state: VpnState;
  mounted: boolean;
  /** Last mount/connect error, user-readable (never a secret). */
  error: string | null;
  last_check: NetworkFolderLastCheck | null;
}

/**
 * One "network folder" (credential kind `smb-folder`) as returned by Hermes
 * `/api/vpn/folders`: an SMB share mounted read-only through one of the
 * caller's Fortinet VPNs and served to the agent by the Folder Bridge tools.
 * Never carries the share password.
 */
export interface NetworkFolderView {
  /** Stable `net-<slug>` id, the bridge folderId the agent uses. */
  id: string;
  name: string;
  vpn: string;
  vpn_slug: string | null;
  /** Normalised `//server/share[/sub...]`. */
  share_path: string;
  share_username: string | null;
  has_share_password: boolean;
  share_domain: string | null;
  trusted_for_import: boolean;
  mount_path: string;
  status: NetworkFolderStatus;
}

/** Body of POST /api/vpn/folders and PUT /api/vpn/folders/{name}. On PUT an
 *  omitted or empty `share_password` keeps the stored one. */
export interface NetworkFolderInput {
  name: string;
  vpn: string;
  share_path: string;
  share_username?: string | null;
  share_password?: string;
  share_domain?: string | null;
  trusted_for_import?: boolean;
}

/**
 * One account in the deployment email poller's config — separate axis from
 * the credential's `email` service flag (that one marks the credential as
 * usable for mail; this one controls whether the background poller runs).
 */
export type EmailSecurity = "ssl" | "starttls";
export type EmailPreset = "gmail" | "outlook" | "other";

/** Server settings a preset fills in (`GET /api/email/mailboxes` presets). */
export interface EmailServerSettings {
  imap_host: string;
  imap_port: number;
  imap_security: EmailSecurity;
  smtp_host: string;
  smtp_port: number;
  smtp_security: EmailSecurity;
}

/** One of the caller's own IMAP/SMTP mailboxes. Never carries the password. */
export interface EmailMailbox extends EmailServerSettings {
  address: string;
  username: string;
  preset: EmailPreset;
  password_set: boolean;
  state: "working" | "needs_attention" | "untested";
  last_test: {
    at: string;
    ok: boolean;
    imap: { ok: boolean; error?: string };
    smtp: { ok: boolean; error?: string };
  } | null;
  last_poll: { at?: string; ok?: boolean; error?: string | null; new_count?: number } | null;
}

/** Body of `PUT /api/email/mailboxes/{address}`; empty password keeps the saved one. */
export interface EmailMailboxInput extends EmailServerSettings {
  username: string;
  password?: string;
  preset: EmailPreset;
}

export interface EmailPollerAccount {
  id: string;
  address: string;
  label: string | null;
  enabled: boolean;
}

/**
 * One WhatsApp bridge sidecar (hermes-wa-bridge-<name>.service) as seen by
 * the deployment dashboard. `qr_pending`/`qr_age_seconds` describe the
 * pairing QR written into the session dir while the bridge waits for a scan.
 */
export interface WaBridge {
  name: string;
  unit: string;
  /** systemctl is-active output: active | activating | inactive | failed… */
  active: string;
  /** Session dir holds creds.json — the bridge has linked before. */
  paired: boolean;
  qr_pending: boolean;
  qr_age_seconds: number | null;
  /** qr.txt older than Baileys' ~60s rotation — almost certainly dead. */
  qr_stale: boolean;
  /** Plain state: waiting_for_qr | connected | not_linked | restarting | stopped | failed. */
  status?: WaBridgeStatus;
  /** The linked phone's own number, masked (only for the bridge's person). */
  number?: string | null;
}

export type WaBridgeStatus =
  | "waiting_for_qr"
  | "connected"
  | "not_linked"
  | "restarting"
  | "stopped"
  | "failed";

/** Someone else's bridge, as owner/admin see it: who and whether it works. */
export interface WaBridgeOther {
  name: string;
  person: string;
  person_display: string;
  status: WaBridgeStatus;
}

export interface WaBridgesResponse {
  /** The caller's own bridges. */
  bridges: WaBridge[];
  /** Other people's bridges (owner/admin only; empty for everyone else). */
  others?: WaBridgeOther[];
  /** Whether this server can add bridges (root helper installed). */
  can_add?: boolean;
}

/** What the to-do filter chips can offer without leading to an empty list. */
export interface TodosFacets {
  stages: { value: string; count: number }[];
  priorities: { value: string; count: number }[];
  source_kinds: { value: string; count: number }[];
}

/**
 * An outgoing action a finished to-do proposes.
 *
 * `channel`, `target` and `account_id` default server-side to the arrival the
 * to-do came from (contract C4: the reply leaves by the account it arrived
 * on), so a client can propose a reply while only drafting the words.
 */
export interface ProposedAction {
  channel?: string;
  target?: string;
  account_id?: string | null;
  thread_id?: string | null;
  subject?: string;
  body: string;
}

/** What the server raised for a proposed action, or why it could not. */
export interface TodoProposal {
  todo_id?: string;
  action?: ProposedAction;
  notification_id?: string;
  /** The command the approval authorises — shown before the user approves. */
  command?: string;
  auto_approved?: boolean;
  error?: string;
}

/**
 * The finished to-do, plus the approval its completion proposed.
 *
 * `proposal` is absent when nothing was proposed, and carries `error` when the
 * work was closed but the draft could not be raised — completing is never lost
 * to a malformed draft.
 */
export interface TodoCompletion extends Todo {
  proposal?: TodoProposal;
}

/** A short-lived signed link to a registered file's bytes. */
export interface FileLinkResponse {
  url: string;
  expires_in: number;
  filename: string;
  content_type: string;
}

/**
 * A goal in the entity's tree (FG-29).
 *
 * `tier` is a *lifetime*, and lifetime decides where the goal is allowed to
 * appear: `entity` and `profile` goals live for quarters and years so they may
 * sit in the cached system prompt, `participant` goals go beside the user
 * profile, and an `operational` goal — which can change mid-session — never
 * reaches a prompt at all.
 */
export interface EntityGoal {
  id: string;
  title: string;
  description: string;
  tier: "entity" | "profile" | "participant" | "operational";
  parent_goal_id: string | null;
  primary_metric: string | null;
  priority: string;
  status: string;
  /** Set on a copy published from another profile; read-only where it landed. */
  published_from_profile: string | null;
  /** True when the source goal changed after this copy was made. */
  stale: boolean;
}

/**
 * The entity goal as settings sees it.
 *
 * `effective` is always `"next_session"`: the goal's text is part of the cached
 * system prompt, so an edit cannot reach a conversation already in flight — the
 * UI says that rather than implying the change is live.
 */
export interface EntityGoalResponse {
  goal: EntityGoal | null;
  created: boolean;
  prompt_tier?: "stable" | "volatile" | "never";
  effective: "next_session";
}

// ── Projects (design ed.3.2 §2–§9, §12) ─────────────────────────────────────

/** ``needs_completion`` is the L2 quarantine for legacy-imported rows —
 * never a state a human picks, only one they work a project out of. */
export type ProjectStatus =
  | "planning"
  | "active"
  | "paused"
  | "done"
  | "archived"
  | "needs_completion";
export type ProjectCadence = "one_off" | "repeatable" | "standing";
export type ProjectAutonomy = "manual" | "supervised" | "autonomous";
export type ProjectVisibility = "shared" | "private";
/** The §9.2 ladder, derived on read — never stored. */
export type ProjectHealth = "ok" | "attention" | "stalled";
export type ProjectMemberRole = "lead" | "member" | "viewer";
export type ProjectLinkKind =
  | "file"
  | "arrival"
  | "todo"
  | "goal"
  | "memory"
  | "conversation"
  | "sample"
  | "reference"
  | "url";
export type ProjectOutputKind =
  | "artifact"
  | "file"
  | "message"
  | "decision"
  | "report"
  | "code";
export type ProjectOutputStatus =
  | "pending"
  | "in_progress"
  | "delivered"
  | "accepted"
  | "dropped";
export type ProjectRunStatus =
  | "running"
  | "waiting"
  | "blocked"
  | "done"
  | "failed"
  | "cancelled";
export type ProjectRunTrigger = "schedule" | "manual" | "event" | "review";

export interface ProjectFolder {
  path: string;
  label: string | null;
  is_primary: boolean;
  added_at: number;
}

/** The project row as `to_dict()` returns it (folders ride with detail). */
export interface Project {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  board_slug: string | null;
  primary_path: string | null;
  archived: boolean;
  created_at: number;
  /** [1] the goal sentence — what success means (distinct from `name`). */
  goal: string | null;
  visibility: ProjectVisibility;
  owner_user_id: string | null;
  status: ProjectStatus;
  cadence: ProjectCadence;
  /** §3.2 schedule text ("every 60m" / cron expression); cron store is authoritative. */
  schedule: string | null;
  /** Standing projects: review period like "30d" / "2w" / "1m". */
  review_every: string | null;
  autonomy: ProjectAutonomy;
  max_in_progress: number;
  budget_usd_per_run: number | null;
  definition_of_done: string | null;
  target_audience: string | null;
  score_rubric: string | null;
  /** CSV narrowing filters; intersected with the host profile at spawn (§4.1). */
  toolsets: string | null;
  skills: string | null;
  due_at: number | null;
  host_profile: string | null;
  cron_job_id: string | null;
  summary: string | null;
  summary_at: number | null;
  last_reviewed_at: number | null;
  /** Display cache only (§3.2) — refreshed on read, never a decision input. */
  next_run_at: number | null;
}

export interface ProjectCardRollup {
  total: number;
  done: number;
  running: number;
  blocked: number;
  /** Archived cards included — the caller-visible total (U5). */
  total_with_archived?: number;
  /** Principal-blind COUNT(*) — what the delete route counts (U8). */
  total_all_principals?: number;
}

/**
 * The §9.1 progress ladder: first rung that applies. `cards` always rides
 * along — it says whether progress is currently moving.
 */
export type ProjectProgress =
  | {
      rung: "standing";
      label: string;
      headline: string;
      cards: ProjectCardRollup;
    }
  | {
      rung: "outputs";
      label: string;
      headline: string;
      accepted: number;
      required: number;
      cards: ProjectCardRollup;
    }
  | {
      rung: "goal";
      label: string;
      headline: string;
      metric: Record<string, unknown>;
      cards: ProjectCardRollup;
    }
  | {
      rung: "cards";
      label: string;
      headline: string;
      cards: ProjectCardRollup;
    };

/** Per-status counts of the declared outputs (§9.1). */
export interface ProjectOutputRollup {
  total: number;
  required: number;
  /** delivered or accepted */
  delivered: number;
  accepted: number;
  /** delivered but not yet accepted — waiting on a human judgement */
  awaiting_acceptance: number;
}

/** One row of `GET /api/registry/projects`. */
export type ProjectListItem = Project & {
  progress: ProjectProgress;
  /** Optional: older BFF/API builds omit it. */
  output_rollup?: ProjectOutputRollup;
  member_count: number;
  health: ProjectHealth;
};

export interface ProjectsResponse {
  items: ProjectListItem[];
  next_cursor: string | null;
}

/** [3] a deliverable, declared before the work. */
export interface ProjectOutput {
  id: string;
  project_id: string;
  seq: number;
  title: string;
  spec: string | null;
  kind: ProjectOutputKind;
  /** SQLite int — truthy means required. */
  required: number;
  recurring: number;
  status: ProjectOutputStatus;
  delivered_at: number | null;
  accepted_at: number | null;
  accepted_by: string | null;
  created_at: number;
}

/** One delivery of an output — which run/card produced it, what the artefact is. */
export interface ProjectDelivery {
  id: string;
  output_id: string;
  run_id: string | null;
  task_id: string | null;
  link_kind: string | null;
  link_ref: string | null;
  profile: string | null;
  label: string | null;
  note: string | null;
  delivered_at: number;
}

export interface ProjectOutputWithDeliveries extends ProjectOutput {
  deliveries: ProjectDelivery[];
}

/** A person on the project (box-wide user id). */
export interface ProjectMember {
  project_id: string;
  user_id: string;
  role: ProjectMemberRole;
  added_by: string | null;
  added_at: number;
}

/** An instrument the work runs on (a profile, not a person). */
export interface ProjectProfileRow {
  project_id: string;
  profile: string;
  role: string;
  added_by: string | null;
  added_at: number;
}

/**
 * [10] a person involved who is not a user of this box. `address` is PII:
 * the Python layer drops it entirely for viewers, so it is optional here.
 */
export interface ProjectContact {
  id: string;
  project_id: string;
  name: string;
  role: string | null;
  org: string | null;
  platform: string | null;
  address?: string | null;
  user_id: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: number;
}

/** A pointer, never an authority (§11 rule 5). */
export interface ProjectLink {
  project_id: string;
  kind: ProjectLinkKind;
  profile: string;
  ref: string;
  label: string | null;
  added_by: string | null;
  added_at: number;
  /** Set on the detail read: url links resolve trivially; others wait for the owning store. */
  resolved?: boolean | null;
}

/** The last N runs as one-line rows. */
export interface ProjectRunBrief {
  run_no: number;
  status: ProjectRunStatus;
  trigger: ProjectRunTrigger;
  started_at: number;
  ended_at: number | null;
  duration_seconds: number | null;
  outcome: string | null;
  score_user: number | null;
  /**
   * §8.2: present only when it diverges from `score_user` by ≥2 —
   * presence IS the learning signal.
   */
  score_self?: number;
}

/** One card's live board state, joined onto a run row. */
export interface ProjectRunCard {
  task_id: string;
  step_key: string | null;
  status: string | null;
  title: string | null;
  /** Worker claims so far (the current one included). */
  attempts?: number;
  /** Closed attempts that ended in crash / timeout / protocol violation. */
  failed_attempts?: number;
  last_error?: string | null;
  last_outcome?: string | null;
}

/** A blocked task in the run's dependency tree — why a run stalls. */
export interface ProjectRunBlockedTask {
  task_id: string;
  title: string | null;
  status: string;
  error: string | null;
}

/** A card in the run's dependency tree that only a person can clear. */
export interface ProjectRunHumanWait {
  task_id: string;
  title: string | null;
  block_kind: string;
  /** The card's latest note — what it is asking for. */
  reason: string | null;
}

/**
 * What a supervised run's checkpoint hold is actually waiting on (§7.1,
 * §12 push edition) — the checkpoint card's own comment, not just a
 * boolean, so the run page can show a person what to look at instead of
 * a generic "there's a checkpoint" sentence.
 */
export interface ProjectRunCheckpointWait {
  checkpoint_task_id: string | null;
  checkpoint_title: string | null;
  /** The checkpoint card's most recent comment (or run summary if it left
   * no comment) — the worker's findings/questions, verbatim. */
  comment: string | null;
  /** The successor card(s) still held in triage until Continue. */
  held_task_ids: string[];
}

/** The full run row (§6) as the detail/list reads return it. */
export interface ProjectRun {
  id: string;
  project_id: string;
  run_no: number;
  trigger: ProjectRunTrigger;
  triggered_by: string | null;
  profile: string;
  playbook_rev: number | null;
  status: ProjectRunStatus;
  started_at: number;
  ended_at: number | null;
  session_id: string | null;
  trace_id: string | null;
  outcome: string | null;
  summary: string | null;
  retro: string | null;
  retro_at: number | null;
  score_self: number | null;
  score_user: number | null;
  score_note: string | null;
  scored_by: string | null;
  scored_at: number | null;
  error: string | null;
  /** Joined fields — present on the detail read. */
  cards?: ProjectRunCard[];
  blocked_tasks?: ProjectRunBlockedTask[];
  /**
   * Server-derived: cards blocked on a person (needs input / capability)
   * holding this run. A run waiting on you is never `stalled`, and scheduled
   * runs are skipped until these are answered.
   */
  waiting_on_you?: ProjectRunHumanWait[];
  cost?: number | null;
  cost_recorded?: boolean;
  duration_seconds?: number;
  deliveries?: ProjectDelivery[] | number;
  /**
   * Server-derived: the row says "running" but no worker is active on it
   * (no running/ready card, and a blocked card or a long silence) — the
   * run is orphaned, not busy.
   */
  stalled?: boolean;
  /** Server-derived 0–100 from the cards' board state (done = 1, running = ½). */
  completion_percent?: number;
  /**
   * Server-derived: a supervised run whose checkpoint step(s) are done while
   * their successors still wait in triage — held on the human's Continue.
   */
  awaiting_continue?: boolean;
  /** `null` while `awaiting_continue` is false; the detail when it's true. */
  checkpoint_wait?: ProjectRunCheckpointWait | null;
}

/** The method, one revision (§7). `steps` is parsed JSON on the detail read. */
export interface PlaybookStep {
  key: string;
  title: string;
  body?: string | null;
  assignee?: string | null;
  /** Step keys this one waits on (the stored name; `needs` is a legacy alias). */
  depends_on?: string[];
  needs?: string[];
  mode?: "card" | "inline";
  checkpoint?: boolean;
  /** Toolsets this step's worker should load (narrowed ∩ host-enabled
   * plus the core floor). Absent = the worker gets the assignee
   * profile's full tool surface. */
  toolsets?: string[];
  [extra: string]: unknown;
}

export interface PlaybookRev {
  project_id: string;
  rev: number;
  body: string;
  steps?: PlaybookStep[];
  active: number;
  created_by: string | null;
  created_at: number;
  activated_at: number | null;
  note: string | null;
}

export interface ProjectPlaybookResponse {
  active: PlaybookRev | null;
  revisions: PlaybookRev[];
}

/** Outcome of asking the agent to draft a plan (server-side job, polled). */
export interface ProjectPlaybookDraftState {
  status: "idle" | "running" | "done" | "failed";
  started_at?: number;
  finished_at?: number;
  /** The proposed (inactive) revision saved when `status === "done"`. */
  rev?: number;
  detail?: string;
}

/** Standing instruction or feedback (§5) — durable, compiled into future runs. */
export interface ProjectDirective {
  id: string;
  project_id: string;
  kind: "directive" | "feedback";
  body: string;
  scope: "project" | "run" | "card";
  target_ref: string | null;
  rating: string | null;
  author_user_id: string;
  created_at: number;
  active: number;
  retired_at: number | null;
  superseded_by: string | null;
}

export interface ProjectDirectivesResponse {
  directives: ProjectDirective[];
  /**
   * §8.2: what runs proposed in their retros — inactive until a member
   * activates them (`POST /directives/:id/activate`).
   */
  proposed?: ProjectDirective[];
  /** §5.1: guidance never applies mid-conversation. */
  applies_from: string;
}

/** The whole record in one read (`GET /{slug}`). */
export interface ProjectDetail extends Project {
  /**
   * Optional in practice: the Python payload pops `folders` out of the base
   * row and the detail read does not re-attach it yet. Read defensively.
   */
  folders?: ProjectFolder[];
  outputs: ProjectOutputWithDeliveries[];
  members: ProjectMember[];
  profiles: ProjectProfileRow[];
  contacts: ProjectContact[];
  links: Partial<Record<ProjectLinkKind, ProjectLink[]>>;
  progress: ProjectProgress;
  output_rollup?: ProjectOutputRollup;
  /**
   * §8.1 derived score — the mean of the last five `score_user` values,
   * never an all-time number; null until somebody scores a run.
   */
  score: ProjectScore | null;
  health: ProjectHealth;
  next_run_at: number | null;
  runs: ProjectRunBrief[];
  card_rollup: ProjectCardRollup;
  recent_events: TaskEventRow[];
  /** Scope clarification state; absent on older servers. */
  clarify?: ClarifySummary | null;
}

/** §8.1: the project's derived score, recomputed on every read. */
export interface ProjectScore {
  mean: number;
  /** How many of the last five scored runs went into the mean. */
  runs: number;
}

/** A kanban `task_events` row as the detail read tails it. */
export interface TaskEventRow {
  id: number | string;
  task_id: string;
  kind: string;
  payload: Record<string, unknown> | null;
  created_at: number;
}

/**
 * §12/§17 step 11: the live-update tail from `GET /projects/:slug/events`.
 * `latest_event_id` names the current head even when `events` is empty —
 * a poller keeps it as the next `since` without a second read.
 */
export interface ProjectEventsResponse {
  events: TaskEventRow[];
  latest_event_id: number;
  since: number;
}

/** One doctor finding (§15 failure mode 1). */
export interface ProjectDoctorFinding {
  code: string;
  severity: "info" | "attention" | "stalled";
  /** The Python payload names the text `detail`; older callers read `message`. */
  detail?: string;
  message?: string;
}

export interface ProjectsDoctorItem {
  slug: string;
  name: string;
  cadence: ProjectCadence;
  findings: ProjectDoctorFinding[];
}

export interface ProjectsDoctorResponse {
  items: ProjectsDoctorItem[];
}

export interface ProjectDoctorDetail {
  slug: string;
  health: ProjectHealth;
  findings: ProjectDoctorFinding[];
  clean: boolean;
}

/** `PUT /{slug}/schedule` result — both halves of the link. */
export interface ProjectScheduleResult {
  schedule: string;
  cron_job_id: string;
  next_run_at: number | null;
  schedule_display?: string | null;
}

/** `PATCH /{slug}/tools` — the resolved intersection with the host profile (§4.1). */
export interface ProjectToolsResolution {
  toolsets: string[];
  skills: string[];
  host_profile: string | null;
  effective_toolsets: string[];
  dropped_toolsets: string[];
  effective_skills: string[];
  dropped_skills: string[];
  skills_truncated: boolean;
}

/** One approval a card worker could not get in-process: `key` is what the
 * approval gate matches (a tool name, or a dangerous-command pattern),
 * `label` what to show, `detail` the call or command it wanted to run. */
export interface ProjectCardApproval {
  key: string;
  label: string;
  detail: string | null;
  requested_at: number;
}

/** A task row on the project board, as `kanban_view.task_dict` returns it. */
export interface ProjectBoardTask {
  id: string;
  title: string;
  body: string | null;
  status: string;
  assignee: string | null;
  priority: number;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  tenant: string | null;
  project_id: string | null;
  result: string | null;
  current_step_key: string | null;
  /** Why a `blocked` card stopped (`kanban_db.VALID_BLOCK_KINDS`), or
   * `null` for a legacy/un-typed block. Absent for every other status. */
  block_kind?: "needs_input" | "capability" | "transient" | null;
  /** Approvals this card's worker asked for and nobody has answered yet
   * (`kanban_db.list_task_approvals`). Only filled on `blocked` cards by
   * the project board read. */
  pending_approvals?: ProjectCardApproval[];
  /** Pinned model for this card's worker (`-m` at dispatch) — the card
   * ignores the main model while this is set. Null/absent = follows main. */
  model_override?: string | null;
  /** The narrowed tool surface stamped on this card at creation
   * (`--toolsets` at dispatch): the step's declared toolsets ∩ the
   * assignee profile's enabled set, plus the core floor. Null/absent =
   * the worker loads the profile's full tool surface. */
  toolsets?: string[] | null;
  [extra: string]: unknown;
}

/** A column of the project's board (`GET /{slug}/board`). */
export interface ProjectBoardColumn {
  name: string;
  tasks: ProjectBoardTask[];
}

/** The derived age metrics `kanban_view.task_dict` joins onto every task. */
export interface ProjectCardAge {
  created_age_seconds: number | null;
  started_age_seconds: number | null;
  time_to_complete_seconds: number | null;
}

/** One entry in a card's comment thread — the worker's own narrated
 * progress updates land here (`kanban_comment`), same table a human's
 * card-page reply would use. */
export interface ProjectCardComment {
  author: string;
  body: string;
  created_at: number;
}

/** The most recent `heartbeat` event that carried a `note` — a running
 * card's lightweight liveness + progress signal (e.g. "93/131 done").
 * `null` when the card has never heartbeat-noted (not yet started, or a
 * worker that never calls out progress). */
export interface ProjectCardHeartbeat {
  note: string;
  created_at: number;
}

/**
 * `GET /{slug}/cards/{task_id}` — `kanban_view.task_dict` verbatim: the
 * board row plus the age metrics, the latest run summary, the comment
 * thread and the latest heartbeat note (when the caller passes one/exist).
 */
export interface ProjectCardDetail extends ProjectBoardTask {
  age?: ProjectCardAge | null;
  latest_summary?: string | null;
  comments?: ProjectCardComment[];
  latest_heartbeat?: ProjectCardHeartbeat | null;
  /**
   * The worker's own log, cleaned of terminal-only noise (ANSI codes,
   * spinner-frame repeats, decorative borders) down to its reasoning
   * sentences and tool-call summaries — the closest thing a
   * board-dispatched card has to a live reasoning stream. `null` before
   * the worker has written anything (or once it's been garbage
   * collected).
   */
  worker_log_tail?: string | null;
  /** Provider-call stats for this card's workers; null when none recorded. */
  model_calls?: CardModelCalls | null;
}

export interface CardCallStats {
  calls: number;
  failures: number;
  min_ms: number | null;
  avg_ms: number | null;
  max_ms: number | null;
}

/** One (attempt, caller, model) slice of a card's calls. */
export interface CardModelCallRow extends CardCallStats {
  run_id: number | null;
  /** 1-based attempt number; null when the call couldn't be tied to a run. */
  attempt: number | null;
  /** How that run ended (`completed`, `crashed`…) or its live status. */
  run_outcome: string | null;
  /** `main`, or `aux:<task>` (e.g. `aux:vision` for image checks). */
  caller: string;
  model: string;
  provider: string;
}

export interface CardModelCalls {
  /** Main-model totals across every attempt; null before the first call. */
  main: CardCallStats | null;
  rows: CardModelCallRow[];
}

export interface ProjectBoardView {
  columns: ProjectBoardColumn[];
  tenants?: string[];
  assignees?: string[];
  latest_event_id?: number | null;
  now?: number;
}

/** Creating a project — the §2.2 mandatory four plus the optional rest. */
export interface CreateProjectPayload {
  goal: string;
  description: string;
  outputs: (string | { title: string; spec?: string; kind?: ProjectOutputKind; required?: boolean; recurring?: boolean })[];
  host_profile: string;
  name?: string;
  slug?: string;
  icon?: string;
  color?: string;
  board_slug?: string;
  primary_path?: string;
  folders?: { path: string; label?: string; is_primary?: boolean }[];
  cadence?: ProjectCadence;
  autonomy?: ProjectAutonomy;
  target_audience?: string;
  definition_of_done?: string;
  visibility?: ProjectVisibility;
  goal_link?: { ref: string; profile?: string; label?: string };
}

/**
 * FG-31 — capacity headroom. One derived verdict plus the reading behind it.
 *
 * `binding_constraint` is the point: a percentage does not tell the owner what
 * to do, and when `hardware_helps` is false a bigger box cannot move the bound
 * at all (SQLite's single writer), so the UI must not offer an upgrade there.
 */
export interface CapacityBound {
  name: string;
  state: "comfortable" | "watch" | "constrained";
  reason: string;
  hardware_helps: boolean;
}

export interface CapacityIndicators {
  active_conversations: number;
  per_profile: Record<string, number>;
  cap_here: number | null;
  /** Sum of every profile's cap; null when any profile leaves it unbounded. */
  cap_box_wide: number | null;
  available_mb: number | null;
  total_mb: number | null;
  hermes_rss_mb: number | null;
  by_process: Record<string, number>;
  write_lock_waits_per_hour: number | null;
  write_lock_waited_s: number | null;
  turn_p50_s: number | null;
  turn_p95_s: number | null;
  turn_samples: number;
  /** Data volume holding hermes home (databases, session dirs, backups). */
  disk_used_mb: number | null;
  disk_total_mb: number | null;
  /** Fraction used, 0..1; null when unmeasured. */
  disk_pct: number | null;
  disk_path: string | null;
  /** 1-minute load average; sustained queueing is what binds the verdict. */
  cpu_load1: number | null;
  cpu_count: number | null;
  /** Instantaneous busy sample — display only, too noisy to judge by. */
  cpu_percent: number | null;
  profile_count: number;
}

/** One hour-aligned bucket of CPU busy% — nulls when nothing was sampled. */
export interface CpuHistoryPoint {
  ts: number;
  avg_pct: number | null;
  max_pct: number | null;
}

export interface CpuHistory {
  /** 24 hourly buckets ending at the current hour (oldest first). */
  hourly: CpuHistoryPoint[];
  /** Busiest sampled minute in each window; null when no samples. */
  max_24h: number | null;
  max_7d: number | null;
  max_30d: number | null;
}

export interface CapacityResponse {
  state: "comfortable" | "watch" | "constrained";
  headline: string;
  summary: string;
  binding_constraint: {
    name: string;
    reason: string;
    hardware_helps: boolean;
  } | null;
  bounds: CapacityBound[];
  recommendations: string[];
  indicators: CapacityIndicators;
  /** Per-minute samples aggregated hourly — only populated once the
   * dashboard's sampler has had time to collect. */
  cpu_history: CpuHistory | null;
  /** Indicators that could not be read — shown as unknown, never as zero. */
  unavailable: string[];
  collected_at: number;
}

/* ── Models page (System ▸ Models) ──────────────────────────────────────
 * Shapes mirror the Python API exactly (`/api/model/*`,
 * `/api/analytics/models`, `/api/providers/validate`, `/api/env`) — the BFF
 * routes pass them through untouched. */

/** Capability metadata resolved from models.dev (may be empty). */
export interface ModelCapabilities {
  supports_tools?: boolean;
  supports_vision?: boolean;
  supports_reasoning?: boolean;
  context_window?: number;
  max_output_tokens?: number;
  model_family?: string;
}

/** `GET /api/model/info` — the configured main model, resolved. */
export interface ModelInfo {
  model: string;
  provider: string;
  auto_context_length: number;
  config_context_length: number;
  effective_context_length: number;
  capabilities: ModelCapabilities;
}

/**
 * One provider row from `GET /api/model/options`. `authenticated=false`
 * rows are catalog skeletons: `key_env` names the env var a key-based
 * provider needs (e.g. `OPENCODE_GO_API_KEY`), `auth_type` tells the UI
 * whether a key field or an onboarding pointer is the right affordance.
 */
export interface ModelProviderOption {
  slug: string;
  name: string;
  is_current?: boolean;
  is_user_defined?: boolean;
  models: string[];
  total_models?: number;
  source?: string;
  authenticated?: boolean;
  auth_type?: string;
  key_env?: string | null;
  /** Env var for a required companion endpoint URL (e.g. Azure Foundry). */
  base_url_env?: string | null;
  warning?: string | null;
}

export interface ModelOptionsResponse {
  providers: ModelProviderOption[];
  /** Currently configured main model/provider (echoed by upstream). */
  model: string;
  provider: string;
}

/** One auxiliary task slot from `GET /api/model/auxiliary`. */
export interface AuxTaskAssignment {
  task: string;
  /** "auto" means the slot inherits the main model. */
  provider: string;
  model: string;
  base_url: string;
  /** This role's own backup list, tried in order when its model fails. */
  fallback_chain?: FallbackModel[];
}

export interface AuxiliaryModelsResponse {
  tasks: AuxTaskAssignment[];
  main: { provider: string; model: string };
}

/** `POST /api/model/test` — one real completion against a slot or ad-hoc
 * provider+model. `ok:false` carries `error`/`error_type`; `ok:true` carries
 * `latency_ms` and a short `reply` excerpt. */
export interface ModelTestResponse {
  ok: boolean;
  provider?: string;
  model?: string;
  latency_ms?: number;
  reply?: string;
  error?: string;
  error_type?: string;
  detail?: string;
}

/** `POST /api/model/set` response — `confirm_required` means resend with `confirm_expensive_model`. */
export interface ModelSetResponse {
  ok: boolean;
  scope?: string;
  confirm_required?: boolean;
  confirm_message?: string;
  stale_aux?: { task: string; provider: string; model: string }[];
  gateway_tools?: unknown;
  detail?: string;
}

/** One model's usage row from `GET /api/analytics/models`. */
export interface ModelUsageEntry {
  model: string;
  provider: string;
  sessions: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  reasoning_tokens: number;
  estimated_cost: number;
  actual_cost: number;
  last_used_at: number | null;
  capabilities: ModelCapabilities;
}

export interface ModelsAnalyticsResponse {
  models: ModelUsageEntry[];
  totals: Record<string, number | null>;
  period_days: number;
}

/* ── Models ▸ Performance (per-call ledger) ────────────────────────── */

/** One day of one model's attempts inside the summary window. */
export interface ModelPerfDaily {
  date: string;
  calls: number;
  failures: number;
  tokens: number;
  avg_ms: number | null;
}

/** One model's stats over the summary window (last `days` days). */
export interface ModelPerformanceEntry {
  model: string;
  provider: string;
  /** Which slots the calls came through: "main", "vision", "compression"… */
  caller_roles: string[];
  calls: number;
  failures: number;
  /** (calls − failures) / calls; null when calls is 0. */
  success_rate: number | null;
  latency_ms: {
    min: number | null;
    avg: number | null;
    p95: number | null;
    max: number | null;
  };
  tokens: {
    input: number;
    output: number;
    cache_read: number;
    reasoning: number;
  };
  /** Session-table cost over the same window, keyed by model. */
  cost_usd: number;
  daily: ModelPerfDaily[];
  /** Other names the provider's replies used for this model
   * (DeepSeek answers `deepseek-v4-flash` as `deepseek-flash`). */
  served_as?: string[];
  /** Why calls failed, most common first. */
  failure_reasons?: { status_code: number | null; error_type: string; count: number }[];
}

/** One backup model, tried in order when the main model fails. */
export interface FallbackModel {
  provider: string;
  model: string;
}

export interface FallbackModelsResponse {
  providers: FallbackModel[];
  /** Provider the built-in last step of an "auto" role would use; null when none has a key. */
  last_resort?: FallbackModel | null;
}

/** `POST /api/providers/refresh-keys` — keys reloaded from `.env`, and the
 * providers whose "this key failed" marks were cleared. */
export interface RefreshKeysResponse {
  ok: boolean;
  reloaded: number;
  cleared: Record<string, number>;
}

/**
 * One model's stats for one calendar month. `avg_ms`/`failures` are null
 * for months that predate the api_call_log ledger — those months still
 * report calls/tokens from the sessions table.
 */
export interface ModelPerfMonth {
  month: string;
  model: string;
  calls: number;
  tokens: number;
  avg_ms: number | null;
  min_ms?: number | null;
  max_ms?: number | null;
  failures: number | null;
}

export interface ModelsPerformanceResponse {
  period: { days: number; months: number };
  models: ModelPerformanceEntry[];
  monthly: ModelPerfMonth[];
  /** True when the ledger has no rows yet — show a "collecting" note. */
  collecting: boolean;
}

/** Aggregated payload the page's BFF route returns in one shot. */
export interface ModelsOverviewResponse {
  info: ModelInfo;
  auxiliary: AuxiliaryModelsResponse;
  usage: ModelUsageEntry[];
  /** Backup models in order; absent when the read failed. */
  fallback?: FallbackModel[];
  /** See FallbackModelsResponse.last_resort. */
  last_resort?: FallbackModel | null;
}

/** `POST /api/providers/validate` response. */
export interface ProviderValidateResponse {
  ok: boolean;
  reachable: boolean;
  message: string;
  models?: string[];
}

/**
 * One card that overrides the configured model — `GET /api/models/pinned`.
 * These cards run `model` regardless of what the main model is set to,
 * which is exactly the blind spot the Models page exists to close.
 */
export interface PinnedModelCard {
  project_slug: string;
  project_name: string;
  task_id: string;
  title: string;
  model: string;
  status: string;
}

export interface PinnedCardsResponse {
  pinned: PinnedModelCard[];
}

/* ── Status strip + Tools & Integrations (settings) ─────────────────────── */

/** `GET /api/system/stats` — the subset the status strip reads. */
export interface SystemStats {
  cpu_percent?: number;
  cpu_count?: number;
  load_avg?: number[];
  memory?: { total: number; available: number; used: number; percent: number };
  disk?: { total: number; used: number; free: number; percent: number };
  uptime_seconds?: number;
}

/** `GET /api/analytics/usage` — only the totals block is consumed. */
export interface UsageAnalytics {
  totals: {
    total_input: number | null;
    total_output: number | null;
    total_cache_read?: number | null;
    total_reasoning?: number | null;
    total_estimated_cost?: number;
    total_actual_cost?: number;
    total_sessions?: number;
    total_api_calls?: number | null;
  };
  period_days?: number;
}

/** `GET /api/cron/jobs` row (loose — only `enabled` is consumed). */
export interface CronJob {
  id?: string;
  name?: string;
  enabled?: boolean;
  next_run_at?: string | number | null;
  [extra: string]: unknown;
}

/** `GET /api/mcp/servers` row. */
export interface McpServer {
  name: string;
  transport: "http" | "stdio" | "unknown";
  url?: string | null;
  command?: string | null;
  args?: string[];
  env?: Record<string, string>;
  /** "oauth" | "header" | null — the auth scheme on the config entry. */
  auth?: string | null;
  enabled: boolean;
  /** Tool allowlist; null/absent = all tools. */
  tools?: unknown;
  /** Present for `auth: "oauth"` servers — whether a token file exists. */
  oauth_token_present?: boolean;
}

export interface McpServersResponse {
  servers: McpServer[];
}

/** One of the signed-in person's own MCP servers (Get ready item 8). */
export interface PersonalMcpServer {
  name: string;
  url: string;
  /** "oauth" when the server needs a sign-in; null otherwise. */
  auth: "oauth" | null;
  /** Names of the saved key headers (values never leave the server). */
  header_names: string[];
  oauth_token_present?: boolean;
}

export interface PersonalMcpServersResponse {
  /** False on installs without per-person sign-in (no multi-user datastore). */
  configured: boolean;
  servers: PersonalMcpServer[];
  limit: number;
}

export interface PersonalMcpCatalogEntry {
  name: string;
  description: string;
  url: string;
  auth: "oauth" | null;
  added: boolean;
}

/** One tool group (toolset) as seen by one role on Settings → Tools. */
export interface RoleToolGroup {
  name: string;
  label: string;
  description: string;
  /** Lets the agent run arbitrary commands (terminal, run code). */
  risky: boolean;
  state: "allowed" | "blocked" | "partial";
  tools: string[];
  blocked_tools: string[];
}

/** `GET /api/access/roles` row — what one role's agent may use. */
export interface RoleLimit {
  role: Role;
  label: string;
  /** The owner row can't be changed. */
  locked: boolean;
  /** Blocked tools come from config.yaml rather than the defaults. */
  customised: boolean;
  files: "any" | "own_folder";
  files_customised: boolean;
  summary: string;
  blocked_tools: string[];
  /** Blocked tools that belong to no listed group. */
  other_blocked_tools: string[];
  groups: RoleToolGroup[];
}

export interface RoleLimitsResponse {
  roles: RoleLimit[];
}

/** `GET /api/tools/toolsets?platform=…` row — one configurable tool group. */
export interface Toolset {
  name: string;
  label: string;
  description: string;
  enabled: boolean;
  available: boolean;
  configured: boolean;
  tools: string[];
}

export interface McpServerTestResult {
  ok: boolean;
  tools: { name: string; description: string }[];
  error?: string;
}

/** Live state of a browser-driven MCP OAuth flow. */
export interface McpOAuthFlowState {
  status: "idle" | "starting" | "waiting_user" | "success" | "error" | "cancelled";
  name?: string;
  authorization_url?: string | null;
  error?: string | null;
  /** Tool count reported after a successful probe. */
  tools?: number;
}

/** `GET /api/status/summary` — the aggregated strip payload. */
export interface StatusSummary {
  cpu_pct: number | null;
  mem_pct: number | null;
  disk_pct: number | null;
  tokens_month: { input: number; output: number; cost_usd: number | null } | null;
  active_conversations: number | null;
  running_cards: number | null;
  cron_total: number;
  cron_enabled: number;
  /** Server bundle's build SHA (NEXT_PUBLIC_HERMES_BUILD); absent on older builds. */
  build?: string | null;
  /** Upload-disk free space — owners/admins only, null for everyone else. */
  upload_storage?: UploadStorageStatus | null;
  collected_at: number;
}

/** `GET /api/capacity/upload-storage` — free space on the disk holding uploads. */
export interface UploadStorageStatus {
  path: string | null;
  free_bytes: number | null;
  total_bytes: number | null;
  /** Warn below this many free bytes (config.yaml `capacity.upload_min_free_*`). */
  min_free_bytes: number | null;
  low: boolean;
}

/** Seminar survey answers, as `validate_answers` in `hermes_cli/seminar_survey.py` accepts them. */
export type SeminarGrade = "P1" | "P2" | "P3" | "P4" | "P5" | "P6";
export type SeminarShare = "named" | "anonymous" | "no";
export type SeminarNextStep =
  | "enrol"
  | "workshop"
  | "consultation"
  | "updates"
  | "not_now";

export interface SeminarSurveyAnswers {
  rating: number;
  grades: SeminarGrade[];
  comment: string;
  share: SeminarShare;
  next_step: SeminarNextStep;
  name: string;
  stay_in_touch: boolean;
}

/** `POST /api/seminar/survey/state`. */
export interface SeminarSurveyState {
  submitted: boolean;
}

/** `POST /api/seminar/survey/submit`. */
export interface SeminarSurveySubmitResult {
  ok: boolean;
  already_submitted: boolean;
}

// ── Projects redesign: ask ──

/** What an "ask the project" answer can cite. */
export type AskProjectSourceKind =
  | "card"
  | "run"
  | "output"
  | "requirement"
  | "plan"
  | "event"
  | "scope";

/** One checked citation: the id is a card id, run number, output id, … */
export interface AskProjectSource {
  kind: AskProjectSourceKind;
  id: string;
  label: string;
}

/** A prior question/answer pair sent back as context (max 6). */
export interface AskProjectHistoryTurn {
  q: string;
  a: string;
}

/** `POST /api/projects/:slug/ask` — read-only, answered in its own session. */
export interface AskProjectResponse {
  answer: string;
  sources: AskProjectSource[];
  /** A requirement the answer suggests, ready for "Turn into a requirement…". */
  suggested_requirement?: string;
}

// ── Projects redesign: outputs ──

/** What a produced file is to the project: attached to a declared output
 * (`deliverable`), a working document a card produced (`draft`), or a
 * working note / log (`note`). */
export type ProjectArtifactKind = "deliverable" | "draft" | "note";

/** Where the artifacts read found the file. */
export type ProjectArtifactSource = "delivery" | "card_file" | "attachment" | "link";

/** `GET /api/registry/projects/:slug/artifacts` — one produced file, newest
 * first. `output_id` is null when no declared output owns the file. */
export interface ProjectArtifact {
  id: string;
  title: string;
  kind: ProjectArtifactKind;
  ext: string | null;
  mime: string | null;
  /** Openable URL or app route (`/api/projects/…/content`); null when the
   * file is not reachable from here (a storage `file` ref opens through
   * `link_ref` instead). */
  href: string | null;
  location: string | null;
  /** The local file is gone (e.g. its card's scratch workspace was cleared
   * on completion) and no remote copy was recorded. Older builds omit it. */
  missing?: boolean;
  source: ProjectArtifactSource;
  link_kind: string | null;
  link_ref: string | null;
  run_id: string | null;
  run_no: number | null;
  card_id: string | null;
  card_title: string | null;
  output_id: string | null;
  output_title: string | null;
  version: number | null;
  created_at: number;
  created_by: string | null;
}

// ── Projects redesign: dashboard ──
/**
 * Optional, server-derived stall flag on the detail read's run brief (the
 * full run row already has it). Older builds omit it; the Dashboard then
 * derives the same rule from the board (`dashboard/derive.ts#runStalled`).
 */
export interface ProjectRunBrief {
  stalled?: boolean;
}

// ── Projects redesign: changes ──
/** What a requirement change is about (the sheet's kind chips). */
export type ProjectChangeKind = "add" | "direction" | "output" | "attach" | "memory";
/** When a change applies: stop the open run now, queue it, or only record it. */
export type ProjectChangeApply = "now" | "next" | "record";

/** What the agent understood from a change (from the seeded plan draft). */
export interface ProjectChangeReading {
  changes: string[];
  affected_outputs: { id: string; title: string }[];
  supersedes: { id: string; body: string }[];
}

export interface ProjectChangeApproval {
  rev: number;
  at: number;
  by: string;
  started: boolean;
  run_no: number | null;
  superseded: string[];
}

/** A directive as the change flow shows it — plain directives have `is_change: false`. */
export interface ProjectChange extends ProjectDirective {
  kinds: ProjectChangeKind[];
  apply: ProjectChangeApply | null;
  is_change: boolean;
  stopped_run: number | null;
  draft_rev: number | null;
  reading: ProjectChangeReading | null;
  approved: ProjectChangeApproval | null;
}

/** `GET /playbook/draft` when the draft was seeded by a change. */
export interface ProjectChangeDraftState extends ProjectPlaybookDraftState {
  change_id?: string;
  reading?: ProjectChangeReading;
}

/** `POST /changes`. */
export interface ProjectChangeResult {
  change: ProjectChange;
  draft: ProjectChangeDraftState;
  stopped_run: number | null;
  applies_from?: string;
  replayed?: boolean;
}

/** `POST /changes/:id/approve`. */
export interface ProjectChangeApproveResult {
  change: ProjectChange;
  rev: number;
  active: true;
  run: ProjectRun | null;
  superseded: string[];
  replayed?: boolean;
}

/** One run in `GET /changes` — the brief plus what the Iterations tab groups by. */
export interface ProjectHistoryRun extends ProjectRunBrief {
  id: string;
  playbook_rev: number | null;
  deliveries: number;
  cards_total: number;
  cards_done: number;
}

/** `GET /changes` — every directive (retired included) and every run. */
export interface ProjectChangesHistory {
  changes: ProjectChange[];
  runs: ProjectHistoryRun[];
  applies_from?: string;
}

// ── Projects redesign: board ──

/** The newest open (running/waiting) run as the board context sees it. */
export interface ProjectBoardOpenRun {
  run_no: number;
  status: string;
  started_at: number | null;
  /** The run's cards the caller can see. */
  card_ids: string[];
  /** Blocked tasks anywhere in the run's dependency tree. */
  blocked_tree_count: number;
  /** The server's `_run_stalled` verdict. */
  stalled: boolean;
}

/** `GET /{slug}/board/context` — what the board rows alone cannot say. */
export interface ProjectBoardContext {
  /** task id → the run number that created the card. */
  card_runs: Record<string, number>;
  open_run: ProjectBoardOpenRun | null;
}

/** One card's outcome in `POST /{slug}/cards/approve`. */
export interface ProjectCardApproveResult {
  task_id: string;
  ok: boolean;
  /** Already past approval: nothing was executed. */
  unchanged?: boolean;
  card?: ProjectBoardTask;
  error?: string;
}

/** `POST /{slug}/cards/approve` — Approve all N. */
export interface ProjectCardsApproveResponse {
  results: ProjectCardApproveResult[];
  approved: number;
  failed: number;
}

// ── Projects: scope clarification (agent asks before implementation) ──

export type ClarifyCategory =
  | "goal"
  | "scope"
  | "audience"
  | "success"
  | "constraints"
  | "inputs"
  | "format"
  | "other";

/** `not_started` (no round) · `open` (latest round has open questions) ·
 * `answered` (all answered/skipped, not confirmed) · `confirmed`. */
export type ClarifyStatus = "not_started" | "open" | "answered" | "confirmed";

export interface ClarifyQuestion {
  id: string;
  round_no: number;
  position: number;
  category: ClarifyCategory;
  question: string;
  /** Why the agent asks — one short line. */
  why: string | null;
  /** Suggested answers the person can tap (may be empty). */
  options: string[];
  allow_multiple: boolean;
  status: "open" | "answered" | "skipped";
  answer: string | null;
  answered_by: string | null;
  answered_at: number | null;
  created_at: number;
}

export interface ClarifyRound {
  round_no: number;
  status: "open" | "answered" | "confirmed";
  /** The agent's summary of the goal and scope (edited on confirm). */
  understanding: string | null;
  /** The agent said it has enough to plan. */
  done: boolean;
  focus: string | null;
  created_by: string;
  created_at: number;
  confirmed_by: string | null;
  confirmed_at: number | null;
}

/** The background question-generation job (like the plan drafter). */
export interface ClarifyJob {
  status: "idle" | "running" | "failed" | "done";
  detail?: string | null;
  started_at?: number;
  finished_at?: number;
  round_no?: number;
}

/** `ProjectDetail.clarify` — the compact state the Dashboard reads. */
export interface ClarifySummary {
  status: ClarifyStatus;
  round: number;
  open_count: number;
  answered_count: number;
  /** The latest *confirmed* understanding. */
  understanding: string | null;
  confirmed_at: number | null;
}

/** `GET /api/registry/projects/:slug/clarify` (and every clarify write's answer). */
export interface ClarifyState extends ClarifySummary {
  rounds: ClarifyRound[];
  /** Every round's questions, oldest round first, in order. */
  questions: ClarifyQuestion[];
  job: ClarifyJob;
}

export interface ClarifyAnswerInput {
  id: string;
  answer?: string;
  skip?: boolean;
}

/** `POST …/clarify/confirm` answer. `plan_draft` is set when a draft was asked for. */
export interface ClarifyConfirmResult {
  state: ClarifyState;
  plan_draft: { status: string; detail?: string | null } | null;
}


// ---------------------------------------------------------------------------
// P2 "Get ready" checklist (GET /api/get-ready, /api/get-ready/people)
// ---------------------------------------------------------------------------

export type GetReadyItemId =
  | "owner"
  | "model"
  | "people"
  | "google"
  | "whatsapp"
  | "telegram"
  | "email"
  | "tools"
  | "vpn"
  | "backups"
  | "security";

export type GetReadyStatus = "done" | "attention" | "not_started";
export type GetReadyGroup = "basics" | "connections" | "safety";

export interface GetReadyTestRecord {
  at: string;
  result: "ok" | "warn" | "bad";
  detail: string;
  params: Record<string, string | number>;
}

export interface GetReadyItem {
  id: GetReadyItemId;
  n: number;
  group: GetReadyGroup;
  required: boolean;
  per_person: boolean;
  status: GetReadyStatus;
  /** Message key; the UI owns the wording (English + Traditional Chinese). */
  detail: string;
  params: Record<string, string | number>;
  coming: boolean;
  steps: { id: string; status: GetReadyStatus }[];
  last_test: GetReadyTestRecord | null;
}

export interface GetReadyResponse {
  role: string;
  can_manage: boolean;
  items: GetReadyItem[];
  summary: { total: number; done: number; attention: number; not_started: number };
}

export type GetReadyConnection = "google" | "whatsapp" | "telegram" | "email" | "tools" | "vpn";

export interface GetReadyConnectionCell {
  state: "set" | "waiting" | "not_set" | "coming";
  reason?: "step_a" | "qr" | "email_test" | "email_error" | "telegram_link";
  count?: number;
}

export interface GetReadyPerson {
  user_id: string;
  display: string;
  role: string;
  is_you: boolean;
  invited_pending: boolean;
  connections: Record<GetReadyConnection, GetReadyConnectionCell>;
}

export interface GetReadyPeopleResponse {
  connections: GetReadyConnection[];
  people: GetReadyPerson[];
}

/** A person's own Telegram bot (Get ready item 6); never carries the token. */
export interface TelegramBotView {
  configured: boolean;
  linked: boolean;
  bot_username?: string | null;
  bot_name?: string | null;
  linked_username?: string | null;
  link_pending?: boolean;
  last_test_ok?: boolean | null;
  last_test_at?: number | null;
  last_test_error?: string | null;
  /** Only on `link/start`: the one-time `t.me/<bot>?start=<code>` link. */
  link_url?: string;
}

// -- offsite backups (Get ready item 10) -------------------------------------

export type OffsiteProvider = "b2" | "s3" | "other";

export type OffsiteBackupState =
  | "unavailable"
  | "not_configured"
  | "running"
  | "backup_failed"
  | "needs_first_backup"
  | "backup_late"
  | "restore_test_failed"
  | "needs_restore_test"
  | "ok";

export interface OffsiteRun {
  at: string;
  ok: boolean;
  error?: string;
  name?: string;
  size?: number;
  tables?: number;
  files?: number;
}

export interface OffsiteBackupStatus {
  available: boolean;
  configured: boolean;
  state: OffsiteBackupState;
  target?: {
    provider: OffsiteProvider;
    bucket: string;
    prefix: string;
    endpoint: string;
    region: string;
    key_id_hint: string;
  } | null;
  schedule?: { enabled: boolean; time: string; keep_days: number };
  running?: {
    kind: "backup" | "restore-test";
    phase: string;
    percent: number;
    started: string;
  } | null;
  last_backup?: OffsiteRun | null;
  last_good_backup?: OffsiteRun | null;
  last_restore_test?: OffsiteRun | null;
  last_check?: { at: string; ok: boolean; error?: string } | null;
  copies?: number | null;
  key_exists?: boolean;
}

export interface OffsiteBackupSettings {
  provider: OffsiteProvider;
  bucket: string;
  key_id: string;
  secret: string;
  endpoint?: string;
  region?: string;
  time?: string;
  keep_days?: number;
  schedule?: boolean;
}

/** Google step A: the install's OAuth client, as the owner sees it (no secret). */
export interface GoogleClientStatus {
  configured: boolean;
  source: "file" | "legacy_file" | "env" | null;
  client_type: "installed" | "web" | "unknown" | null;
  /** A shortened client ID, enough to recognise it. */
  client_id_hint: string | null;
  /** Owner ticks for steps 1–5 (done in Google Cloud, which Aquarium can't see). */
  steps: Record<"1" | "2" | "3" | "4" | "5", boolean>;
  last_check: { result: GoogleClientCheck; at: number } | null;
  scopes: string[];
  redirect_uri: string;
}

export type GoogleClientCheck =
  | "ok"
  | "invalid_client"
  | "redirect_mismatch"
  | "unreachable"
  | "unexpected"
  | "missing";

export interface GoogleClientSaveResult {
  saved: boolean;
  check: GoogleClientCheck;
  client: GoogleClientStatus;
}

// -- Files → Browse ---------------------------------------------------------

/** A server-side place the caller may browse (`/api/browse/places`). */
export interface BrowsePlace {
  /** `net-<slug>` for a network folder, `workspace` for the caller's own. */
  id: string;
  kind: "network" | "workspace";
  name: string;
  vpn?: string | null;
  /** Someone else's network folder shared with the caller. */
  shared?: boolean;
  trusted_for_import?: boolean;
  mounted?: boolean;
  error?: string | null;
}

/** One entry of a folder listing; `path` is relative to the place. */
export interface BrowseEntry {
  name: string;
  path: string;
  kind: "file" | "directory";
  size: number | null;
  modified_at: string | null;
}

export interface BrowseListing {
  place: string;
  path: string;
  entries: BrowseEntry[];
  truncated: boolean;
}

/** `POST /api/browse/save` — the file copied into the caller's Files. */
export interface BrowseSaveResult {
  ok: boolean;
  detail?: string;
  assetId?: string;
  filename?: string;
  size?: number;
}
