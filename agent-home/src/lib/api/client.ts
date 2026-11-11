/**
 * Typed client for the Python AI layer (`/api/*`, `/auth/*`) — FG-20 Wave A2.
 *
 * This is the *only* channel `agent-home` uses for anything agent- or
 * authority-related (one-brain chat, CDP webview, GTS authority writes,
 * onboarding readiness, Core manifest, tool enable/promote, comms). It never
 * re-implements that logic — it forwards to the Python API and replays the
 * bridged Hermes session token so the call is authenticated exactly as the
 * dashboard's own requests are (the gate reads the `hermes_session_at` cookie;
 * see `hermes_cli/dashboard_auth/cookies.py`).
 *
 * Server-only: the browser never calls the Python API directly (BFF pattern),
 * so this module holds the upstream token and runs on the `agent-home` server.
 */
import "server-only";

import { activeEnrolments } from "@/lib/api/my-profiles";
import type { SkillVersionDetail, SkillVersionDiff, SkillVersionList } from "@/lib/skills/versions";
import { hermesApiBaseUrl } from "@/lib/env";
import type { SecurityBasicsResult } from "@/lib/api/security-basics";
import type { AquariumSettings, AquariumSnapshot, CreatureId } from "@/lib/aquarium/creatures";
import type { ModelTimeoutChange, ModelTimeoutsState } from "@/lib/model-timeouts";
import type { MySkillPermissions, SkillPermissionsChange, SkillsAccessResponse } from "@/lib/skills/permissions";
import type { SkillUsageEvent, SkillUsageList } from "@/lib/skills/usage";
import type { PinResponse, PinSuggestionsResponse } from "@/types/landing";
import type {
  ChatInputMode,
  ActivityItem,
  GoogleClientCheck,
  GoogleClientSaveResult,
  GoogleClientStatus,
  AgentAttachmentPayload,
  CapacityResponse,
  UploadStorageStatus,
  ChangeOpResponse,
  ChangesResponse,
  ChatMessagesResponse,
  ChatSendResponse,
  CoreManifestResponse,
  CreateProjectPayload,
  ProjectViewMode,
  QuickTaskPayload,
  QuickTaskResponse,
  QuickTaskStartResponse,
  ViewDevice,
  DirectoryResponse,
  EntityGoalResponse,
  FileAsset,
  FileAssetsResponse,
  FileLinkResponse,
  FileSurfacesResponse,
  GtsGraphResponse,
  IdentityActivityResponse,
  IncomingDetail,
  IncomingItem,
  IncomingsFacets,
  IncomingsResponse,
  MemberChannelsResponse,
  MemberCreateResponse,
  MemberDeleteResponse,
  MemberDisplayResponse,
  MemberImportResponse,
  MemberInvitationResponse,
  MemberOkResponse,
  MemberRoleResponse,
  MembersResponse,
  MemoryDocumentsResponse,
  ModelInfo,
  OffsiteBackupStatus,
  SoftwareUpgradeStatus,
  ModelOptionsResponse,
  ModelSetResponse,
  ModelTestResponse,
  ModelsAnalyticsResponse,
  ModelsPerformanceResponse,
  AuxiliaryModelsResponse,
  ProviderValidateResponse,
  MemoryProjection,
  MemoryQueryPlacement,
  MemoryRowsResponse,
  MemorySummary,
  NotificationAnswerResponse,
  NotificationsResponse,
  OnboardingReadinessResponse,
  Principal,
  ProfileCreateInput,
  ProfileCreateResult,
  ProfileDescribeResult,
  MyProfilesResponse,
  PersonProfilesResponse,
  ProfilesResponse,
  SkillHubPreview,
  SkillHubScan,
  SkillHubSearchResponse,
  SkillHubSourcesResponse,
  SkillDetails,
  SkillInfo,
  ProfileSuggestionAdoptResponse,
  ProfileSuggestionDismissResponse,
  ProfileSuggestionsResponse,
  Project,
  ProjectBoardView,
  ProjectCardDetail,
  RefResolution,
  ProjectContact,
  ProjectDetail,
  ProjectDirectivesResponse,
  ProjectDoctorDetail,
  ProjectEventsResponse,
  ProjectLink,
  ProjectOutput,
  ProjectPlaybookDraftState,
  ProjectPlaybookResponse,
  AssignableProfilesResponse,
  ProjectRun,
  ProjectScheduleResult,
  ProjectsDoctorResponse,
  ProjectCategoriesResponse,
  ProjectCategory,
  ProjectsResponse,
  ProjectToolsResolution,
  ProposedAction,
  Role,
  RoleLimitsResponse,
  AgentHomeNav,
  SessionCreateResponse,
  CredentialEntry,
  EmailMailbox,
  EmailMailboxInput,
  MssqlConnection,
  MssqlConnectionInput,
  WinrmConnection,
  WinrmConnectionInput,
  EmailPollerAccount,
  EmailServerSettings,
  NetworkFolderInput,
  NetworkFolderView,
  BrowseListing,
  BrowsePlace,
  BrowseSaveResult,
  VpnView,
  WaBridge,
  WaBridgesResponse,
  SessionTag,
  SessionsResponse,
  CronJob,
  McpOAuthFlowState,
  McpServersResponse,
  McpServerTestResult,
  PersonalMcpCatalogEntry,
  PersonalMcpServer,
  PersonalMcpServersResponse,
  SystemStats,
  TagSuggestion,
  Toolset,
  UsageAnalytics,
  Todo,
  TodoCompletion,
  TodoDetail,
  TodosFacets,
  TodosResponse,
  StoreMode,
  ToolsResponse,
  TraceDetailResponse,
  TracesResponse,
  WebviewActionKind,
  WebviewActionResponse,
  WebviewMode,
  WebviewSessionResponse,
  SeminarSurveyAnswers,
  SeminarSurveyState,
  SeminarSurveySubmitResult,
  GetReadyItem,
  GetReadyPeopleResponse,
  GetReadyResponse,
  TelegramBotView,
  FallbackModel,
  FallbackModelsResponse,
  RefreshKeysResponse,
  PinnedModelCard,
} from "@/types";

/** Per-person Telegram bot actions forwarded to Hermes `/api/telegram-bot/*`. */
export type TelegramBotAction = "test" | "link/start" | "link/check" | "link";

/** Raised when the Python API returns a non-2xx status. */
export interface AccountSecurity {
  email: string;
  two_factor: { enabled: boolean; recovery_codes_left: number };
}

export const TWO_FACTOR_ACTIONS = ["start", "confirm", "disable", "recovery-codes"] as const;
export type TwoFactorAction = (typeof TWO_FACTOR_ACTIONS)[number];

export interface TwoFactorResult {
  ok?: boolean;
  secret?: string;
  otpauth_uri?: string;
  recovery_codes?: string[];
}

export class HermesApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "HermesApiError";
  }
}

/**
 * The upstream's own wording when it sent one (F6). Every BFF route and
 * page that renders ``err.message`` must reach a user with the API's
 * copy — *retire one first*, the budget refusal — never with the
 * internal path and status, which is topology nobody can act on.
 */
function upstreamDetail(parsed: unknown, fallback: string): string {
  if (
    parsed &&
    typeof parsed === "object" &&
    typeof (parsed as { detail?: unknown }).detail === "string" &&
    (parsed as { detail: string }).detail
  ) {
    return (parsed as { detail: string }).detail;
  }
  return fallback;
}

export interface HermesApiClientOptions {
  /** The bridged upstream Hermes access token to replay (from the session). */
  hermesToken?: string;
  /** Override the base URL (tests / non-default topology). */
  baseUrl?: string;
  /**
   * Bind every call to a named Hermes profile (FG-28). A profile *is* a
   * `HERMES_HOME`: its own SOUL, config, memory, skills, credentials and
   * `state.db`. Binding it on the client rather than per call is what keeps a
   * turn and the reads around it (session list, transcript, tags) on the same
   * profile — a per-method flag drifts the moment one call site forgets it.
   * Omitted or `"default"` means the box's own home, unchanged.
   */
  profile?: string;
}

/**
 * Box-wide Python routes (FG-28 B4, `hermes_cli/profile_route_scope.py`
 * `BOX_WIDE_PREFIXES`): they act on the host or the whole box and answer 400
 * to a non-acting `?profile=`, so the bound profile is never added to them.
 */
const BOX_WIDE_PATHS = [
  "/api/software-upgrade",
  "/api/hermes/update",
  "/api/security-basics",
  "/api/backups/offsite",
  "/api/vpn",
  "/api/internal/vpn",
  "/api/git",
  "/api/fs",
  "/api/files",
  "/api/browse",
  "/api/dashboard",
  "/api/system/stats",
  "/api/capacity",
  "/api/quotas/box",
  "/api/ops",
  "/api/logs",
  "/api/gateway/drain",
  "/api/audio",
  "/api/wa-bridges",
  "/api/email-accounts",
  "/api/comms/people",
  "/api/aquarium",
] as const;

export function isBoxWidePath(path: string): boolean {
  const pathname = path.split(/[?#]/, 1)[0].replace(/\/+$/, "");
  return BOX_WIDE_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** Rows per `GET /api/sessions` page when reading a whole conversation list. */
export const SESSION_PAGE_SIZE = 200;

/**
 * The `platform_toolsets` key Aquarium chats are built with
 * (`gateway.session_chat.build_session_agent`, `platform="api_server"`).
 * The OpenAI-compatible API (`gateway/platforms/api_server.py`) shares it.
 */
export const CHAT_TOOLSET_PLATFORM = "api_server";
/** Upper bound on pages `allSessions` reads (10,000 conversations). */
const SESSION_PAGE_MAX_PAGES = 50;

/**
 * A thin, typed `fetch` wrapper around the Python API. Construct one per
 * request from the bridged session token; methods return parsed JSON typed to
 * the shared entity shapes.
 */
export class HermesApiClient {
  private readonly baseUrl: string;
  private readonly hermesToken?: string;
  private readonly profile?: string;

  constructor(opts: HermesApiClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? hermesApiBaseUrl()).replace(/\/+$/, "");
    this.hermesToken = opts.hermesToken;
    const profile = (opts.profile ?? "").trim();
    this.profile = profile && profile !== "default" ? profile : undefined;
  }

  /** The profile this client is bound to, or undefined for the box's own home. */
  boundProfile(): string | undefined {
    return this.profile;
  }

  /**
   * Add the bound profile to a path's query string. The Python API reads
   * `?profile=` on its read endpoints; an endpoint that doesn't declare it
   * ignores the parameter, so this is safe to apply uniformly.
   */
  private scopedPath(path: string): string {
    if (!this.profile || isBoxWidePath(path)) return path;
    const sep = path.includes("?") ? "&" : "?";
    return `${path}${sep}profile=${encodeURIComponent(this.profile)}`;
  }

  /** Add the bound profile to a JSON body (write endpoints read it there). */
  private scopedJson(json: unknown): unknown {
    if (!this.profile || json === undefined) return json;
    if (json === null || typeof json !== "object" || Array.isArray(json)) return json;
    return { profile: this.profile, ...(json as Record<string, unknown>) };
  }

  /** Low-level request. Prefer the typed methods below where they exist. */
  async request<T>(
    path: string,
    init: RequestInit & { json?: unknown } = {},
  ): Promise<T> {
    const { json: rawJson, headers, ...rest } = init;
    const json = isBoxWidePath(path) ? rawJson : this.scopedJson(rawJson);
    path = this.scopedPath(path);
    const finalHeaders = new Headers(headers);
    if (this.hermesToken) {
      // Replay the bridged session both as the dashboard cookie the gate reads
      // and as a bearer header, so either verification path accepts it.
      finalHeaders.set("cookie", `hermes_session_at=${this.hermesToken}`);
      finalHeaders.set("authorization", `Bearer ${this.hermesToken}`);
    }
    if (json !== undefined) {
      finalHeaders.set("content-type", "application/json");
    }
    this.applyIdempotencyKey(finalHeaders, rest.method);
    // Latency measurement: every page render fans out through this one seam,
    // so timing here attributes page-load seconds to specific upstream
    // endpoints (visible in `journalctl -u agent-home`). Covers fetch +
    // body read, which is everything the BFF pays for the call.
    const started = Date.now();
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...rest,
      headers: finalHeaders,
      body: json !== undefined ? JSON.stringify(json) : rest.body,
      // Server-to-server on the same box: never cache authority responses.
      cache: "no-store",
    });
    const text = await res.text();
    const elapsedMs = Date.now() - started;
    const timingLine = `api-timing ${rest.method ?? "GET"} ${path} status=${res.status} elapsed_ms=${elapsedMs}`;
    if (elapsedMs >= 500) console.warn(timingLine);
    else console.log(timingLine);
    const parsed = text ? safeJson(text) : undefined;
    if (!res.ok) {
      throw new HermesApiError(
        res.status,
        upstreamDetail(parsed, "That didn't go through."),
        parsed ?? text,
      );
    }
    return parsed as T;
  }

  /**
   * The profiles the signed-in account may chat in (FG-28 D3): its *active*
   * enrolments. Each is an independent `HERMES_HOME` — its own SOUL, goal,
   * skills, memory and credentials — so the chat surface can address one
   * deliberately instead of always the default. Never the box's full list: a
   * profile you are not enrolled in is not yours to address.
   */
  async profiles(): Promise<ProfilesResponse> {
    return { profiles: activeEnrolments(await this.myProfiles()) };
  }

  /**
   * A person's enrolment in each profile the signed-in account administers
   * (box-wide: never bound to a profile). Other profiles are never listed.
   */
  async personProfiles(userId: string): Promise<PersonProfilesResponse> {
    return this.request(`/api/comms/people/${encodeURIComponent(userId)}/profiles`);
  }

  /** Every enrolment of the signed-in account, with its role in each profile. */
  async myProfiles(): Promise<MyProfilesResponse> {
    return this.request("/api/auth/my-profiles");
  }

  // ── Profiles & Skills management (owner/admin pages) ──────────────────
  // Profile-scoped skill calls get `?profile=` / `profile` from the client's
  // bound profile (see `scopedPath` / `scopedJson`).

  async profileInfos(): Promise<{ profiles: Array<Record<string, unknown>> }> {
    return this.request("/api/profiles");
  }

  async createProfile(input: ProfileCreateInput): Promise<ProfileCreateResult> {
    return this.request("/api/profiles", { method: "POST", json: input });
  }

  async renameProfile(name: string, newName: string): Promise<{ ok: boolean; name: string }> {
    return this.request(`/api/profiles/${encodeURIComponent(name)}`, {
      method: "PATCH",
      json: { new_name: newName },
    });
  }

  async deleteProfile(name: string): Promise<{ ok: boolean }> {
    return this.request(`/api/profiles/${encodeURIComponent(name)}`, { method: "DELETE" });
  }

  async profileSoul(name: string): Promise<{ content: string; exists?: boolean }> {
    return this.request(`/api/profiles/${encodeURIComponent(name)}/soul`);
  }

  async setProfileSoul(name: string, content: string): Promise<{ ok: boolean }> {
    return this.request(`/api/profiles/${encodeURIComponent(name)}/soul`, {
      method: "PUT",
      json: { content },
    });
  }

  async setProfileDescription(
    name: string,
    description: string,
  ): Promise<{ ok: boolean; description: string; description_auto: boolean }> {
    return this.request(`/api/profiles/${encodeURIComponent(name)}/description`, {
      method: "PUT",
      json: { description },
    });
  }

  async describeProfileAuto(name: string, overwrite: boolean): Promise<ProfileDescribeResult> {
    return this.request(`/api/profiles/${encodeURIComponent(name)}/describe-auto`, {
      method: "POST",
      json: { overwrite },
    });
  }

  async setProfileModel(
    name: string,
    provider: string,
    model: string,
  ): Promise<{ ok: boolean; provider: string; model: string }> {
    return this.request(`/api/profiles/${encodeURIComponent(name)}/model`, {
      method: "PUT",
      json: { provider, model },
    });
  }

  async skillList(): Promise<SkillInfo[]> {
    return this.request("/api/skills");
  }

  async toggleSkill(name: string, enabled: boolean): Promise<{ ok: boolean }> {
    return this.request("/api/skills/toggle", { method: "PUT", json: { name, enabled } });
  }

  async skillContent(name: string): Promise<{ name: string; content: string }> {
    return this.request(`/api/skills/content?name=${encodeURIComponent(name)}`);
  }

  async skillDetails(name: string): Promise<SkillDetails> {
    return this.request(`/api/skills/details?name=${encodeURIComponent(name)}`);
  }

  async skillUsage(days: number): Promise<SkillUsageList> {
    return this.request(`/api/skills/usage?days=${days}`);
  }

  async skillUsageFeedback(input: { event_id: number; rating: -1 | 1; note?: string }): Promise<SkillUsageEvent> {
    return this.request("/api/skills/usage/feedback", { method: "POST", json: input });
  }

  async createSkill(input: {
    name: string;
    content: string;
    category?: string;
  }): Promise<{ success: boolean; message?: string }> {
    return this.request("/api/skills", { method: "POST", json: input });
  }

  async updateSkillContent(name: string, content: string): Promise<{ success: boolean; message?: string }> {
    return this.request("/api/skills/content", { method: "PUT", json: { name, content } });
  }

  async skillVersions(name: string): Promise<SkillVersionList> {
    return this.request(`/api/skills/versions?name=${encodeURIComponent(name)}`);
  }

  async skillVersionDetail(name: string, id: string): Promise<SkillVersionDetail> {
    return this.request(`/api/skills/versions/detail?name=${encodeURIComponent(name)}&id=${encodeURIComponent(id)}`);
  }

  async skillVersionDiff(name: string, a: string, b: string): Promise<SkillVersionDiff> {
    return this.request(
      `/api/skills/versions/diff?name=${encodeURIComponent(name)}&a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`,
    );
  }

  async activateSkillVersion(input: { name: string; id: string; trial: boolean }): Promise<SkillVersionList> {
    return this.request("/api/skills/versions/activate", { method: "POST", json: input });
  }

  async skillHubSources(): Promise<SkillHubSourcesResponse> {
    return this.request("/api/skills/hub/sources");
  }

  async skillHubSearch(q: string, limit = 20): Promise<SkillHubSearchResponse> {
    return this.request(
      `/api/skills/hub/search?q=${encodeURIComponent(q)}&source=all&limit=${limit}`,
    );
  }

  async skillHubPreview(identifier: string): Promise<SkillHubPreview> {
    return this.request(`/api/skills/hub/preview?identifier=${encodeURIComponent(identifier)}`);
  }

  async skillHubScan(identifier: string): Promise<SkillHubScan> {
    return this.request(`/api/skills/hub/scan?identifier=${encodeURIComponent(identifier)}`);
  }

  async installHubSkill(identifier: string): Promise<{ ok: boolean; pid?: number }> {
    return this.request("/api/skills/hub/install", { method: "POST", json: { identifier } });
  }

  async uninstallHubSkill(name: string): Promise<{ ok: boolean; pid?: number }> {
    return this.request("/api/skills/hub/uninstall", { method: "POST", json: { name } });
  }

  // --- Profile suggestions (FG-30) ---------------------------------------
  // The Python API is the authority: it enforces owner-only adopt/dismiss by
  // binding the requesting principal (`_comms_resolve_principal`, the #253
  // fix), and the dedup_key latches a dismissal forever. These methods just
  // forward; a 403 from upstream is the real gate, not a BFF re-derivation.

  /**
   * This profile's open suggestion (`suggestions`, at most one per §1.1) plus a
   * capped `reviewed` trail so the owner keeps a trace of what they just did.
   * The trail carries no `evidence` — that blob holds the participants roster.
   * Any enrolled principal may read; adopt/dismiss are owner-only action routes.
   */
  async profileSuggestions(): Promise<ProfileSuggestionsResponse> {
    return this.request("/api/profiles/suggestions");
  }

  /**
   * Adopt a suggestion (owner only). Returns the new profile's path and
   * goal — the new profile is channel-less until the owner commits one (§3).
   */
  async adoptProfileSuggestion(
    suggestionId: string,
  ): Promise<ProfileSuggestionAdoptResponse> {
    return this.request(
      `/api/profiles/suggestions/${encodeURIComponent(suggestionId)}/adopt`,
      { method: "POST" },
    );
  }

  /**
   * Dismiss a suggestion (owner only). `reason` is optional and recorded in
   * the C5 audit. A dismissal is **permanent** for that evidence: the
   * `dedup_key` latches it, so the same cluster is never re-proposed (§1.1).
   */
  async dismissProfileSuggestion(
    suggestionId: string,
    reason?: string,
  ): Promise<ProfileSuggestionDismissResponse> {
    const json = reason ? { reason } : undefined;
    return this.request(
      `/api/profiles/suggestions/${encodeURIComponent(suggestionId)}/dismiss`,
      { method: "POST", json },
    );
  }

  /**
   * FG-31 capacity headroom — one verdict naming the bound that produced it.
   * Read-only, and box-wide: the active-session registry is profile-local, so
   * Python aggregates every profile's leases rather than reporting this one's.
   */
  async capacity(): Promise<CapacityResponse> {
    return this.request("/api/capacity");
  }

  /** Free space on the disk holding uploads (the Supabase storage volume). */
  async uploadStorage(): Promise<UploadStorageStatus> {
    return this.request("/api/capacity/upload-storage");
  }

  // --- Status strip + Tools & Integrations -------------------------------

  /** Host stats (psutil-backed): CPU, memory, disk, uptime. */
  async systemStats(): Promise<SystemStats> {
    return this.request("/api/system/stats");
  }

  /** Token/cost rollup for the trailing `days` (profile-scoped upstream). */
  async usageAnalytics(days = 30): Promise<UsageAnalytics> {
    return this.request(`/api/analytics/usage?days=${days}`);
  }

  /** Cron jobs. With no bound profile the upstream default lists every
   * profile's jobs; a bound client sees its own profile's set. */
  async cronJobs(): Promise<CronJob[]> {
    return this.request("/api/cron/jobs");
  }

  /** Configured MCP servers for the bound profile. */
  async mcpServers(): Promise<McpServersResponse> {
    return this.request("/api/mcp/servers");
  }

  /** Enable/disable an MCP server (`enabled` flag in config.yaml). */
  async setMcpServerEnabled(
    name: string,
    enabled: boolean,
  ): Promise<{ ok: boolean; name: string; enabled: boolean }> {
    return this.request(
      `/api/mcp/servers/${encodeURIComponent(name)}/enabled`,
      { method: "PUT", json: { enabled } },
    );
  }

  /** Probe one server: connect, list tools, disconnect. */
  async testMcpServer(name: string): Promise<McpServerTestResult> {
    return this.request(
      `/api/mcp/servers/${encodeURIComponent(name)}/test`,
      { method: "POST", json: {} },
    );
  }

  async deleteMcpServer(name: string): Promise<{ ok: boolean }> {
    return this.request(`/api/mcp/servers/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
  }

  /**
   * Configurable tool groups with their enable state for `platform` —
   * by default the one Aquarium chats are built with.
   */
  async toolsets(platform: string = CHAT_TOOLSET_PLATFORM): Promise<Toolset[]> {
    return this.request(
      `/api/tools/toolsets?platform=${encodeURIComponent(platform)}`,
    );
  }

  async setToolsetEnabled(
    name: string,
    enabled: boolean,
    platform: string = CHAT_TOOLSET_PLATFORM,
  ): Promise<{ ok: boolean; name: string; platform: string; enabled: boolean }> {
    return this.request(`/api/tools/toolsets/${encodeURIComponent(name)}`, {
      method: "PUT",
      json: { enabled, platform },
    });
  }

  /** What each role's agent may use (Settings → Tools, "What each role can use"). */
  async roleLimits(): Promise<RoleLimitsResponse> {
    return this.request("/api/access/roles");
  }

  /** Replace a role's blocked tools, or `reset` it to the defaults. Owner/admin only. */
  async setRoleLimits(
    role: string,
    change: { deny_tools: string[] } | { reset: true },
  ): Promise<{ ok: boolean } & RoleLimitsResponse> {
    return this.request(`/api/access/roles/${encodeURIComponent(role)}`, {
      method: "PUT",
      json: change,
    });
  }

  /** What each role may do with skills (Settings → Skills permissions). Owner/admin only. */
  async skillPermissions(): Promise<SkillsAccessResponse> {
    return this.request("/api/access/skills");
  }

  /** Change some of a role's skill permissions, or `reset` them. Returns every role, normalised. */
  async setSkillPermissions(role: string, change: SkillPermissionsChange): Promise<SkillsAccessResponse> {
    return this.request(`/api/access/skills/${encodeURIComponent(role)}`, {
      method: "PUT",
      json: change,
    });
  }

  /** What the signed-in caller may do with skills in the bound profile. */
  async mySkillPermissions(): Promise<MySkillPermissions> {
    return this.request("/api/access/skills/me");
  }

  /** Which agent-home menu items the caller may see (Settings → Menu). */
  async agentHomeNav(): Promise<AgentHomeNav> {
    return this.request("/api/agent-home/nav");
  }

  /** Replace a role's hidden menu items. Owner/admin only. */
  async setAgentHomeNav(
    role: string,
    hidden: string[],
  ): Promise<{ ok: boolean } & AgentHomeNav> {
    return this.request(`/api/agent-home/nav/${encodeURIComponent(role)}`, {
      method: "PUT",
      json: { hidden },
    });
  }

  /**
   * Browser-driven OAuth re-auth for an `auth: oauth` MCP server (Canva,
   * Vercel, …). Start returns immediately; poll status until
   * `authorization_url` appears, open it, then hand the final redirect URL
   * to `mcpOauthRedirect` — the flow completes via the stock drop-file path.
   */
  async mcpOauthStart(name: string): Promise<McpOAuthFlowState> {
    return this.request(
      `/api/mcp/servers/${encodeURIComponent(name)}/oauth/start`,
      { method: "POST", json: {} },
    );
  }

  async mcpOauthStatus(name: string): Promise<McpOAuthFlowState> {
    return this.request(
      `/api/mcp/servers/${encodeURIComponent(name)}/oauth/status`,
    );
  }

  async mcpOauthRedirect(
    name: string,
    url: string,
  ): Promise<{ ok: boolean }> {
    return this.request(
      `/api/mcp/servers/${encodeURIComponent(name)}/oauth/redirect`,
      { method: "POST", json: { url } },
    );
  }

  async mcpOauthCancel(name: string): Promise<{ ok: boolean }> {
    return this.request(
      `/api/mcp/servers/${encodeURIComponent(name)}/oauth/cancel`,
      { method: "POST", json: {} },
    );
  }

  /** The signed-in person's own MCP servers (only theirs; Get ready item 8). */
  async personalMcpServers(): Promise<PersonalMcpServersResponse> {
    return this.request("/api/mcp/personal");
  }

  async addPersonalMcpServer(body: {
    name: string;
    url: string;
    headers?: Record<string, string>;
    auth?: "oauth";
  }): Promise<PersonalMcpServer> {
    return this.request("/api/mcp/personal", { method: "POST", json: body });
  }

  async deletePersonalMcpServer(name: string): Promise<{ ok: boolean }> {
    return this.request(`/api/mcp/personal/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
  }

  async testPersonalMcpServer(name: string): Promise<McpServerTestResult> {
    return this.request(`/api/mcp/personal/${encodeURIComponent(name)}/test`, {
      method: "POST",
      json: {},
    });
  }

  async personalMcpCatalog(): Promise<{ entries: PersonalMcpCatalogEntry[] }> {
    return this.request("/api/mcp/personal/catalog");
  }

  /** Owner/admin: how many own tools each person has (counts only). */
  async personalMcpByPerson(): Promise<{ people: { user_id: string; servers: number }[] }> {
    return this.request("/api/mcp/personal/people");
  }

  async personalMcpOauth(
    name: string,
    step: "start" | "status" | "redirect" | "cancel",
    url?: string,
  ): Promise<McpOAuthFlowState & { ok?: boolean }> {
    const path = `/api/mcp/personal/${encodeURIComponent(name)}/oauth/${step}`;
    if (step === "status") return this.request(path);
    return this.request(path, { method: "POST", json: step === "redirect" ? { url } : {} });
  }

  /** Resolve the C1 principal + role for the current bridged session. */
  async whoami(): Promise<{ configured: boolean; principal: Principal | null }> {
    return this.request("/api/comms/whoami");
  }

  /** The signed-in person's own saved preferences (``language`` is null until
   * chosen; ``project_view_mode`` holds only the device classes chosen so far). */
  async myPreferences(): Promise<{
    language: string | null;
    project_view_mode?: Partial<Record<ViewDevice, ProjectViewMode>>;
  }> {
    return this.request("/api/me/preferences");
  }

  /** Save the signed-in person's Projects view for one device class. */
  async setMyProjectViewMode(
    device: ViewDevice,
    mode: ProjectViewMode,
  ): Promise<{ project_view_mode: Partial<Record<ViewDevice, ProjectViewMode>> }> {
    return this.request("/api/me/preferences", {
      method: "PUT",
      json: { project_view_mode: { device, mode } },
    });
  }

  /** Save the signed-in person's own language; nobody else's. */
  async setMyLanguage(language: string): Promise<{ language: string }> {
    return this.request("/api/me/preferences", { method: "PUT", json: { language } });
  }

  /** Every active person as a creature with their usage (cached ≤ 4 s upstream). */
  async aquariumSnapshot(): Promise<AquariumSnapshot> {
    return this.request("/api/aquarium/snapshot");
  }

  /** The box-wide idle seconds and aquarium name. Any signed-in person. */
  async aquariumSettings(): Promise<AquariumSettings> {
    return this.request("/api/aquarium/settings");
  }

  /** Change any of the box-wide aquarium settings; returns all. Owner/admin only (Python re-checks). */
  async setAquariumSettings(patch: Partial<AquariumSettings>): Promise<AquariumSettings> {
    return this.request("/api/aquarium/settings", { method: "PUT", json: patch });
  }

  /** Model API timeouts per provider/model and the pairs in use. Owner/admin only. */
  async modelTimeouts(): Promise<ModelTimeoutsState> {
    return this.request("/api/model-timeouts");
  }

  /** Set or clear (`timeout_seconds: null`) one timeout in every profile; returns all. */
  async setModelTimeout(change: ModelTimeoutChange): Promise<ModelTimeoutsState> {
    return this.request("/api/model-timeouts", { method: "PUT", json: change });
  }

  /** The signed-in person's creature; `chosen` is false for the fallback. */
  async myCreature(): Promise<{ creature: CreatureId; chosen: boolean }> {
    return this.request("/api/me/creature");
  }

  /** Save the signed-in person's own creature; nobody else's. */
  async setMyCreature(creature: CreatureId): Promise<{ creature: CreatureId; chosen: boolean }> {
    return this.request("/api/me/creature", { method: "PUT", json: { creature } });
  }

  /** List the interactive auth providers (login-page bootstrap). Unauthed. */
  async authProviders(): Promise<{
    providers: { name: string; display_name: string; supports_password: boolean }[];
  }> {
    return this.request("/api/auth/providers");
  }

  /**
   * The FG-18 GTS Centre graph (C9) scoped to the principal (C2 + item_grants
   * RLS, enforced server-side in the Python layer). Read-only: creation and
   * scoring stay on the CLI/agent authority paths, so there is no write here.
   */
  async gtsGraph(): Promise<GtsGraphResponse> {
    return this.request("/api/gts/graph");
  }

  /**
   * The FG-14 C7 Core-boundary projection (read-only): active manifest globs,
   * boundary health, and the tail of the Core-denial audit log. Core is
   * immutable to the runtime agent, so this only reflects the boundary.
   */
  async coreManifest(limit = 50): Promise<CoreManifestResponse> {
    return this.request(`/api/core/manifest?limit=${encodeURIComponent(limit)}`);
  }

  /**
   * The C2-scoped list of C8 interaction traces (read-only). Scoping is
   * enforced upstream by the Python ledger; the browser never sees traces the
   * principal may not.
   */
  async traces(limit = 50): Promise<TracesResponse> {
    return this.request(`/api/comms/traces?limit=${encodeURIComponent(limit)}`);
  }

  /** One trace's C2-scoped interaction timeline + rollup (read-only). */
  async trace(traceId: string): Promise<TraceDetailResponse> {
    return this.request(`/api/comms/traces/${encodeURIComponent(traceId)}`);
  }

  /** The C2-scoped FG-12 change log (read-only in this surface). */
  async changes(): Promise<ChangesResponse> {
    return this.request("/api/comms/changes");
  }

  /**
   * The FG-15 onboarding readiness (read-only): the CLI's setup schema +
   * `ready_for_prod` gate. Reports secret *presence* only, never values.
   */
  async onboardingReadiness(): Promise<OnboardingReadinessResponse> {
    return this.request("/api/onboarding/readiness");
  }

  /** The P2 Get ready checklist for the signed-in person (status only). */
  async getReady(): Promise<GetReadyResponse> {
    return this.request("/api/get-ready");
  }

  /** Run one checklist item's live check; returns the refreshed item. */
  async getReadyTest(item: string): Promise<GetReadyItem> {
    return this.request(`/api/get-ready/${encodeURIComponent(item)}/test`, {
      method: "POST",
    });
  }

  /** Owner/admin: each person's connection status (never secrets). */
  async getReadyPeople(): Promise<GetReadyPeopleResponse> {
    return this.request("/api/get-ready/people");
  }

  /**
   * The tool registry (apps the agent built or installed) for a datastore
   * mode, scoped upstream to the logged-in person. Read-only here.
   */
  async tools(mode?: StoreMode): Promise<ToolsResponse> {
    const qs = mode ? `?mode=${encodeURIComponent(mode)}` : "";
    return this.request(`/api/tools${qs}`);
  }

  /**
   * List the principal's conversations (read path). Recent-first; callers
   * scope via `source`/`excludeSources` (the chat pane lists everything
   * except cron jobs).
   */
  async sessions(
    opts: {
      source?: string;
      excludeSources?: string;
      limit?: number;
      offset?: number;
      order?: "created" | "recent";
      archived?: "exclude" | "only" | "include";
      tags?: string;
      excludeTags?: string;
      tagMatch?: string;
      /** `only` = just the caller's pinned chats, whatever their age. */
      pinned?: "only";
    } = {},
  ): Promise<SessionsResponse> {
    const params = new URLSearchParams();
    if (opts.source) params.set("source", opts.source);
    if (opts.excludeSources) params.set("exclude_sources", opts.excludeSources);
    params.set("limit", String(opts.limit ?? 30));
    if (opts.offset) params.set("offset", String(opts.offset));
    params.set("order", opts.order ?? "recent");
    if (opts.archived) params.set("archived", opts.archived);
    if (opts.tags) params.set("tags", opts.tags);
    if (opts.excludeTags) params.set("exclude_tags", opts.excludeTags);
    if (opts.tagMatch) params.set("tag_match", opts.tagMatch);
    if (opts.pinned) params.set("pinned", opts.pinned);
    return this.request(`/api/sessions?${params.toString()}`);
  }

  /**
   * Every conversation matching `opts`, read page by page. Pages advance by
   * the upstream's unfiltered `total` because tag filters are applied after
   * paging, so a filtered page can be short or empty mid-list.
   */
  async allSessions(
    opts: Omit<Parameters<HermesApiClient["sessions"]>[0], "limit" | "offset"> = {},
  ): Promise<SessionsResponse> {
    const seen = new Set<string>();
    const sessions: SessionsResponse["sessions"] = [];
    let total = 0;
    for (let page = 0; page < SESSION_PAGE_MAX_PAGES; page += 1) {
      const offset = page * SESSION_PAGE_SIZE;
      const res = await this.sessions({ ...opts, limit: SESSION_PAGE_SIZE, offset });
      total = res.total ?? 0;
      for (const s of res.sessions) {
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        sessions.push(s);
      }
      if (offset + SESSION_PAGE_SIZE >= total) break;
    }
    return { sessions, total, limit: sessions.length, offset: 0 };
  }

  /**
   * Load one conversation's persisted transcript (read path). No options is
   * the legacy every-row read; `visible` keeps user/assistant turns only,
   * `limit` returns the newest N rows older than `before` (a message id)
   * plus `has_more`.
   */
  async sessionMessages(
    sessionId: string,
    opts: { visible?: boolean; limit?: number; before?: number } = {},
  ): Promise<ChatMessagesResponse> {
    const params = new URLSearchParams();
    if (opts.visible) params.set("visible", "true");
    if (opts.limit !== undefined && Number.isFinite(opts.limit)) {
      params.set("limit", String(opts.limit));
    }
    if (opts.before !== undefined && Number.isFinite(opts.before)) {
      params.set("before", String(opts.before));
    }
    const query = params.toString();
    return this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/messages${query ? `?${query}` : ""}`,
    );
  }

  /**
   * Create a new conversation (owner-attributed) via `POST /api/sessions`.
   * Idempotent server-side: a supplied id that already exists is a 409.
   */
  async createSession(sessionId?: string): Promise<SessionCreateResponse> {
    return this.request("/api/sessions", {
      method: "POST",
      json: sessionId ? { session_id: sessionId } : {},
    });
  }

  /**
   * Rename a conversation via `PATCH /api/sessions/{id}` (title only). An empty
   * string clears the title; the backend rejects a duplicate title with 400.
   */
  async renameSession(
    sessionId: string,
    title: string,
  ): Promise<{ ok: boolean; title: string }> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      json: { title },
    });
  }

  /**
   * Archive or unarchive a conversation via `PATCH /api/sessions/{id}`
   * (`archived` only). Archived conversations are hidden from the default list
   * (`archived=exclude`) and returned by `archived=only`.
   */
  async setSessionArchived(
    sessionId: string,
    archived: boolean,
  ): Promise<{ ok: boolean; archived: boolean }> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      json: { archived },
    });
  }

  // ── Session pins (per user, per profile) ─────────────────────────

  /** Pin or unpin a conversation for the caller (idempotent). */
  async setSessionPinned(sessionId: string, pinned: boolean): Promise<PinResponse> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/pin`, {
      method: "POST",
      json: { pinned },
    });
  }

  /** The agent's cached "worth pinning" suggestions for the caller. */
  async pinSuggestions(): Promise<PinSuggestionsResponse> {
    return this.request(`/api/sessions/pin-suggestions`);
  }

  /** Dismiss suggestions for good (until nothing — they never come back). */
  async dismissPinSuggestions(sessionIds: string[]): Promise<{ dismissed: string[] }> {
    return this.request(`/api/sessions/pin-suggestions/dismiss`, {
      method: "POST",
      json: { session_ids: sessionIds },
    });
  }

  // ── Session tags ──────────────────────────────────────────────────

  /** List all tags in the workspace with session counts. */
  async listTags(): Promise<{ tags: SessionTag[] }> {
    return this.request(`/api/sessions/tags`);
  }

  /** Create a standalone tag (not attached to any session). */
  async createTag(
    name: string,
    color?: string,
  ): Promise<{ tag: SessionTag }> {
    return this.request(`/api/sessions/tags`, {
      method: "POST",
      json: { name, color: color ?? "blue" },
    });
  }

  /** Get tags attached to a session. */
  async getSessionTags(sessionId: string): Promise<{ tags: SessionTag[] }> {
    return this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/tags`,
    );
  }

  /** Attach an existing-or-new tag to a session. */
  async addSessionTag(
    sessionId: string,
    name: string,
    color?: string,
  ): Promise<{ tag: SessionTag }> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionId)}/tags`, {
      method: "POST",
      json: { name, color: color ?? "blue" },
    });
  }

  /** Remove a tag from a session. */
  async removeSessionTag(
    sessionId: string,
    tagId: string,
  ): Promise<{ ok: boolean }> {
    return this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/tags/${encodeURIComponent(tagId)}`,
      { method: "DELETE" },
    );
  }

  /** Delete a tag entirely (removes all session assignments). */
  async deleteTag(tagId: string): Promise<{ ok: boolean }> {
    return this.request(`/api/sessions/tags/${encodeURIComponent(tagId)}`, {
      method: "DELETE",
    });
  }

  /** LLM-suggested tags for a session (awaiting user confirmation). */
  async suggestSessionTags(
    sessionId: string,
  ): Promise<{ suggestions: TagSuggestion[] }> {
    return this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/tags/suggest`,
      { method: "POST" },
    );
  }

  // ── Cross-session search ─────────────────────────────────────────

  /** FTS5 search across all sessions, returning matching snippets. */
  async searchSessions(
    query: string,
    limit = 20,
  ): Promise<{
    results: Array<{
      session_id: string;
      snippet: string;
      role: string;
      source: string;
      model?: string;
      session_started?: number;
      title?: string | null;
    }>;
  }> {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    return this.request(`/api/sessions/search?${params.toString()}`);
  }

  /**
   * Send one one-brain turn to a conversation via
   * `POST /api/sessions/{id}/chat` and return the assistant reply. The turn is
   * driven by the shared `AIAgent` + `SessionDB` under the C1 principal — this
   * client never re-implements the conversation loop, it forwards the message.
   */
  async sendChat(
    sessionId: string,
    message: string,
    attachments?: AgentAttachmentPayload[],
  ): Promise<ChatSendResponse> {
    return this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/chat`,
      {
        method: "POST",
        json:
          attachments && attachments.length > 0
            ? { message, attachments }
            : { message },
      },
    );
  }

  /**
   * Open a streaming turn via `POST /api/sessions/{id}/chat/stream` and return
   * the raw SSE `Response` for the BFF to proxy to the browser. Unlike
   * `request()`, this does NOT consume the body — the caller pipes it through.
   * Tool-approval prompts (approvals.tools) arrive mid-stream as
   * `approval.request` events carrying the run_id; resolve them with
   * `resolveRunApproval`. This is what gives agent-home chat an approval
   * surface, so gated tools (e.g. calendar) prompt instead of failing closed.
   */
  async openChatStream(
    sessionId: string,
    message: string,
    attachments?: AgentAttachmentPayload[],
  ): Promise<Response> {
    const headers = new Headers({ "content-type": "application/json" });
    if (this.hermesToken) {
      headers.set("cookie", `hermes_session_at=${this.hermesToken}`);
      headers.set("authorization", `Bearer ${this.hermesToken}`);
    }
    // Streams bypass `request()` (the body is piped, not consumed), so the
    // bound profile is applied here explicitly — a streamed turn must run under
    // the same profile's brain as a non-streamed one.
    const body = this.scopedJson(
      attachments && attachments.length > 0
        ? { message, attachments }
        : { message },
    );
    const res = await fetch(
      `${this.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/chat/stream`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        cache: "no-store",
      },
    );
    if (!res.ok || !res.body) {
      const text = res.body ? await res.text().catch(() => "") : "";
      throw new HermesApiError(
        res.status,
        upstreamDetail(text ? safeJson(text) : undefined, "That didn't go through."),
        text,
      );
    }
    return res;
  }

  /**
   * The caller's lead conversation: one session per person, the same one on
   * every device they sign in on. Created on the first ask.
   */
  async leadSession(): Promise<{
    session_id: string;
    resume_session_id: string;
    created: boolean;
  }> {
    return this.request<{
      session_id: string;
      resume_session_id: string;
      created: boolean;
    }>(`/api/sessions/lead`);
  }

  /**
   * The in-flight turn for a session, if any — a reloaded page asks this
   * first, then re-attaches to the stream to resume live rendering.
   */
  async activeChatRun(sessionId: string): Promise<ActiveChatRun> {
    return this.request<ActiveChatRun>(
      `/api/sessions/${encodeURIComponent(sessionId)}/active_run`,
    );
  }

  /**
   * Re-attach to an in-flight (or grace-window) turn: the upstream replays
   * the buffered events, then tails the run live. Returns the raw SSE
   * `Response` for the BFF to pipe, like `openChatStream`.
   */
  async openAttachStream(sessionId: string, runId: string): Promise<Response> {
    const headers = new Headers({ "content-type": "application/json" });
    if (this.hermesToken) {
      headers.set("cookie", `hermes_session_at=${this.hermesToken}`);
      headers.set("authorization", `Bearer ${this.hermesToken}`);
    }
    const res = await fetch(
      `${this.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/chat/stream/attach`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(this.scopedJson({ run_id: runId })),
        cache: "no-store",
      },
    );
    if (!res.ok || !res.body) {
      const text = res.body ? await res.text().catch(() => "") : "";
      throw new HermesApiError(
        res.status,
        upstreamDetail(text ? safeJson(text) : undefined, "That run can no longer be attached."),
        text,
      );
    }
    return res;
  }

  /**
   * Stop an in-flight turn. Closing the SSE connection deliberately does not
   * stop the server-side turn, so Stop is an explicit verb
   * (`POST /api/sessions/{id}/chat/stream/cancel`).
   */
  async cancelChatRun(
    sessionId: string,
    runId: string,
  ): Promise<{ run_id: string; cancelled: boolean; done: boolean }> {
    return this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/chat/stream/cancel`,
      { method: "POST", json: { run_id: runId } },
    );
  }

  /**
   * Hand a message to an in-flight turn: `steer` injects it after the
   * agent's current tool step, `queue` runs it as the next turn, `interrupt`
   * stops the turn and runs it next. 409 `run_finished` once the run is done.
   */
  async steerChatRun(
    sessionId: string,
    runId: string,
    text: string,
    mode: ChatInputMode,
  ): Promise<{ run_id: string; mode: ChatInputMode; item_id: string; status: "pending" | "queued" }> {
    return this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/chat/stream/steer`,
      { method: "POST", json: { run_id: runId, text, mode } },
    );
  }

  /** Drop a queued message that has not started yet. */
  async removeQueuedChatInput(
    sessionId: string,
    runId: string,
    itemId: string,
  ): Promise<{ removed: boolean }> {
    return this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/chat/stream/queue/remove`,
      { method: "POST", json: { run_id: runId, item_id: itemId } },
    );
  }

  /**
   * Resolve a pending tool approval for a streamed run. `choice` is one of
   * `once | session | always | deny` (or `approve`, aliased server-side).
   * Forwards to `POST /v1/runs/{run_id}/approval` → `resolve_gateway_approval`,
   * which unblocks the waiting agent turn. This client never decides consent.
   */
  async resolveRunApproval(
    runId: string,
    choice: string,
  ): Promise<{ object: string; run_id: string; choice: string; resolved: number }> {
    return this.request(`/v1/runs/${encodeURIComponent(runId)}/approval`, {
      method: "POST",
      json: { choice },
    });
  }

  /**
   * The caller's open FG-17b webview session (C6 consent-gated), or the
   * default-deny empty state (`session: null`) when none is open. Read path.
   */
  async getWebviewSession(): Promise<WebviewSessionResponse> {
    return this.request("/api/webview/session");
  }

  /**
   * Opt in: open a webview session with an explicit consent scope (allowed
   * domains + read-only/interactive). Attributed to the owner principal
   * (never spoofed). Default-deny means nothing runs until this is called.
   */
  async openWebviewSession(scope: {
    allowed_domains: string[];
    mode: WebviewMode;
  }): Promise<WebviewSessionResponse> {
    return this.request("/api/webview/session", {
      method: "POST",
      json: scope,
    });
  }

  /** Close (opt out of) the caller's webview session. */
  async closeWebviewSession(): Promise<{ ok: boolean; closed: boolean }> {
    return this.request("/api/webview/session", { method: "DELETE" });
  }

  /**
   * Request one agent action against the live page. The Option-B policy
   * (enforced server-side) either allows it (runs via CDP + C8 trace) or
   * escalates it to a per-action C6 approval — this client never decides.
   */
  async requestWebviewAction(action: {
    kind: WebviewActionKind;
    url?: string | null;
    credentialed?: boolean;
    destructive?: boolean;
  }): Promise<WebviewActionResponse> {
    return this.request("/api/webview/action", {
      method: "POST",
      json: action,
    });
  }

  /** Grant or deny a queued per-action C6 approval; on grant the action runs. */
  async resolveWebviewApproval(
    approvalId: string,
    grant: boolean,
  ): Promise<WebviewActionResponse> {
    return this.request(
      `/api/webview/approval/${encodeURIComponent(approvalId)}`,
      { method: "POST", json: { grant } },
    );
  }

  /** List pending comms/notifications visible to the principal (C2-scoped). */
  async notifications(): Promise<NotificationsResponse> {
    return this.request("/api/comms/notifications");
  }

  /**
   * Settle a pending FG-10 item (approval grant/deny, or ask acknowledge). The
   * answer is idempotent across surfaces; `newly_answered` is false if another
   * surface (e.g. Telegram) settled it first. Write path (principal, no `?as=`).
   */
  async answerNotification(
    notificationId: string,
    answer: string,
  ): Promise<NotificationAnswerResponse> {
    return this.request(
      `/api/comms/notifications/${encodeURIComponent(notificationId)}/answer`,
      { method: "POST", json: { answer } },
    );
  }

  /** Undo a visible, reversible FG-12 change (C2 + D6 enforced upstream). */
  async undoChange(changeRef: string): Promise<ChangeOpResponse> {
    return this.request(
      `/api/comms/changes/${encodeURIComponent(changeRef)}/undo`,
      { method: "POST" },
    );
  }

  /** Redo a previously-undone, visible FG-12 change (C2 enforced upstream). */
  async redoChange(changeRef: string): Promise<ChangeOpResponse> {
    return this.request(
      `/api/comms/changes/${encodeURIComponent(changeRef)}/redo`,
      { method: "POST" },
    );
  }

  // --- User management (FG-26, owner/admin unless noted) -------------------
  // The Python layer is the authority: it independently enforces the
  // owner/admin guard and drives GoTrue + the principal store. These methods
  // just forward; the service-role key never leaves the box, and **no password
  // crosses this seam in either direction** — a new account is created banned
  // with a server-side random password and activated from an invitation.

  /** One page of this profile's roster, searched/filtered in Postgres. */
  async members(
    opts: {
      limit?: number;
      offset?: number;
      q?: string;
      role?: Role;
      /** `true` = enrolled here, `false` = suspended here, omitted = both. */
      active?: boolean;
    } = {},
  ): Promise<MembersResponse> {
    const query = new URLSearchParams();
    if (opts.limit !== undefined) query.set("limit", String(opts.limit));
    if (opts.offset !== undefined) query.set("offset", String(opts.offset));
    if (opts.q) query.set("q", opts.q);
    if (opts.role) query.set("role", opts.role);
    if (opts.active !== undefined) query.set("active", String(opts.active));
    const suffix = query.toString();
    return this.request(`/api/comms/members${suffix ? `?${suffix}` : ""}`);
  }

  /**
   * The colleague directory — readable by **every enrolled principal**, not
   * just admins. Built from this profile's principals, never from the box-wide
   * account table.
   */
  async directory(
    opts: { limit?: number; offset?: number; q?: string } = {},
  ): Promise<DirectoryResponse> {
    const query = new URLSearchParams();
    if (opts.limit !== undefined) query.set("limit", String(opts.limit));
    if (opts.offset !== undefined) query.set("offset", String(opts.offset));
    if (opts.q) query.set("q", opts.q);
    const suffix = query.toString();
    return this.request(`/api/comms/directory${suffix ? `?${suffix}` : ""}`);
  }

  /**
   * Enrol somebody into `profile` (owner/admin). `profile` is **required** and
   * travels to the server, which refuses a foreign profile with 409 before any
   * account is created (cross-profile assignment is FG-28's).
   */
  async createMember(input: {
    email: string;
    profile: string;
    display?: string;
    role?: Role;
  }): Promise<MemberCreateResponse> {
    return this.request("/api/comms/members", { method: "POST", json: input });
  }

  /** Preview (or apply) a `email,display,role` CSV bulk enrolment. */
  async importMembers(input: {
    csv: string;
    profile: string;
    dry_run: boolean;
  }): Promise<MemberImportResponse> {
    return this.request("/api/comms/members/import", {
      method: "POST",
      json: input,
    });
  }

  /** Mint (or regenerate) a one-time activation link — shown exactly once. */
  async issueMemberInvitation(
    userId: string,
  ): Promise<MemberInvitationResponse> {
    return this.request(
      `/api/comms/members/${encodeURIComponent(userId)}/invitation`,
      { method: "POST" },
    );
  }

  /** Revoke every open invitation for a user (a mis-sent link, killed). */
  async revokeMemberInvitation(
    userId: string,
  ): Promise<{ ok: boolean; revoked: number }> {
    return this.request(
      `/api/comms/members/${encodeURIComponent(userId)}/invitation`,
      { method: "DELETE" },
    );
  }

  /** Rename a member within this profile (owner/admin). */
  async setMemberDisplay(
    userId: string,
    display: string,
  ): Promise<MemberDisplayResponse> {
    return this.request(
      `/api/comms/members/${encodeURIComponent(userId)}/display`,
      { method: "PUT", json: { display } },
    );
  }

  /** Map an inbound channel handle onto an enrolled member (owner/admin). */
  async linkMemberChannel(
    userId: string,
    input: { platform: string; channel_user_id: string },
  ): Promise<MemberChannelsResponse> {
    return this.request(
      `/api/comms/members/${encodeURIComponent(userId)}/channels`,
      { method: "POST", json: input },
    );
  }

  /** Detach a channel handle from a member (owner/admin). */
  async unlinkMemberChannel(
    userId: string,
    input: { platform: string; channel_user_id: string },
  ): Promise<MemberChannelsResponse> {
    const query = new URLSearchParams(input);
    return this.request(
      `/api/comms/members/${encodeURIComponent(userId)}/channels?${query.toString()}`,
      { method: "DELETE" },
    );
  }

  /** Recent identity-administration events from the C5 log (owner/admin). */
  async memberActivity(limit = 50): Promise<IdentityActivityResponse> {
    return this.request(`/api/comms/members/activity?limit=${limit}`);
  }

  /**
   * Remove an enrolment (owner/admin), stating what happens to the rows it
   * owns: `transfer` needs `transferTo`, `purge` deletes the private ones.
   * Nothing cascades to memories, files or GTS items, hence the requirement.
   */
  async deleteMember(
    userId: string,
    opts: { strategy: "transfer" | "purge"; transferTo?: string },
  ): Promise<MemberDeleteResponse> {
    const query = new URLSearchParams({ strategy: opts.strategy });
    if (opts.transferTo) query.set("transfer_to", opts.transferTo);
    return this.request(
      `/api/comms/members/${encodeURIComponent(userId)}?${query.toString()}`,
      { method: "DELETE" },
    );
  }

  /**
   * Redeem an invitation: set the password and lift the ban. **Unauthenticated**
   * upstream (the invitee has no session yet), and every failure mode answers
   * identically so this cannot be used to discover whether a token was real.
   */
  async redeemInvitation(
    input: {
      token: string;
      password: string;
      /** The named profile from `/activate/<profile>/<token>`. */
      profile?: string;
    },
    clientIp = "",
  ): Promise<{ ok: boolean }> {
    return this.request("/api/auth/invitations/redeem", {
      method: "POST",
      json: input,
      headers: forwardedFor(clientIp),
    });
  }

  /** First-run owner setup (hermes_cli/first_run.py): is this link usable? */
  async setupCheck(
    token: string,
    clientIp = "",
  ): Promise<{ ok: boolean; steps?: boolean }> {
    return this.request("/api/setup/check", {
      method: "POST",
      json: { token },
      headers: forwardedFor(clientIp),
    });
  }

  /** First-run owner setup: create the owner's login from the one-time link. */
  async setupOwner(
    input: { token: string; email: string; password: string },
    clientIp = "",
  ): Promise<{ ok: boolean }> {
    return this.request("/api/setup/owner", {
      method: "POST",
      json: input,
      headers: forwardedFor(clientIp),
    });
  }

  /** First-run AI model step: probe, save and test a provider key. */
  async setupModel(
    input: { token: string; provider: string; api_key: string },
    clientIp = "",
  ): Promise<SetupModelResult> {
    return this.request("/api/setup/model", {
      method: "POST",
      json: input,
      headers: forwardedFor(clientIp),
    });
  }

  /** First-run timezone (config.yaml `timezone`). */
  async setupRegion(
    input: { token: string; timezone: string },
    clientIp = "",
  ): Promise<{ ok: boolean }> {
    return this.request("/api/setup/region", {
      method: "POST",
      json: input,
      headers: forwardedFor(clientIp),
    });
  }

  /** First-run read-only domain check (DNS + HTTPS). */
  async setupDomain(
    input: { token: string; host: string },
    clientIp = "",
  ): Promise<SetupDomainResult> {
    return this.request("/api/setup/domain", {
      method: "POST",
      json: input,
      headers: forwardedFor(clientIp),
    });
  }

  /** Two-factor status of the signed-in person's own login. */
  async accountSecurity(): Promise<AccountSecurity> {
    return this.request("/api/account/security");
  }

  /** Change the signed-in person's own password (`code` when two-factor is on). */
  async changePassword(
    input: { current_password: string; new_password: string; code?: string },
    clientIp = "",
  ): Promise<{ ok: boolean }> {
    return this.request("/api/account/password", {
      method: "POST",
      json: input,
      headers: forwardedFor(clientIp),
    });
  }

  /** One two-factor step for the signed-in person's own login. */
  async twoFactor(
    action: TwoFactorAction,
    input: { password?: string; code?: string },
    clientIp = "",
  ): Promise<TwoFactorResult> {
    return this.request(`/api/account/two-factor/${action}`, {
      method: "POST",
      json: input,
      headers: forwardedFor(clientIp),
    });
  }

  /** Ask an administrator for a reset link. Always answers `{ok: true}`. */
  async requestInvitation(
    email: string,
    clientIp = "",
    /** The sign-in page's `?profile=`: where the request should land. */
    profile = "",
  ): Promise<{ ok: boolean }> {
    return this.request("/api/auth/invitations/request", {
      method: "POST",
      json: profile ? { email, profile } : { email },
      headers: forwardedFor(clientIp),
    });
  }

  // --- Seminar survey (unauthenticated) --------------------------------
  // Keyed by the personal token sent into the attendee's WhatsApp chat; the
  // Python API throttles both per IP and per token.

  /** Whether the survey behind `token` is still open. 404 for an unknown link. */
  async seminarSurveyState(
    token: string,
    clientIp = "",
  ): Promise<SeminarSurveyState> {
    return this.request("/api/seminar/survey/state", {
      method: "POST",
      json: { token },
      headers: forwardedFor(clientIp),
    });
  }

  /** Store the answers; the slides follow on WhatsApp. Repeat submits are no-ops. */
  async submitSeminarSurvey(
    input: { token: string; answers: SeminarSurveyAnswers },
    clientIp = "",
  ): Promise<SeminarSurveySubmitResult> {
    return this.request("/api/seminar/survey/submit", {
      method: "POST",
      json: input,
      headers: forwardedFor(clientIp),
    });
  }

  /** Change a member's role (never the owner; never to owner). */
  async setMemberRole(userId: string, role: Role): Promise<MemberRoleResponse> {
    return this.request(
      `/api/comms/members/${encodeURIComponent(userId)}/role`,
      { method: "PUT", json: { role } },
    );
  }

  /** Suspend a member's enrolment in this profile (the account survives). */
  async deactivateMember(userId: string): Promise<MemberOkResponse> {
    return this.request(
      `/api/comms/members/${encodeURIComponent(userId)}/deactivate`,
      { method: "POST" },
    );
  }

  /** Restore a suspended enrolment in this profile. */
  async activateMember(userId: string): Promise<MemberOkResponse> {
    return this.request(
      `/api/comms/members/${encodeURIComponent(userId)}/activate`,
      { method: "POST" },
    );
  }

  // --- FG-23 memory explorer (read-only) -----------------------------------
  // Unlike `tools(mode)`, these deliberately do NOT forward
  // AGENT_HOME_DATASTORE_MODE — the Python layer resolves the memory tier's
  // own mode (FG-23 D3). Sending `prod` on the current box would report zero
  // memories from an empty `app_prod` schema.

  /** The C2-scoped memory summary: counts, embedding-space health, recall use. */
  async memorySummary(): Promise<MemorySummary> {
    return this.request("/api/memory/explorer/summary");
  }

  /** Paginated + semantic-search rows. `limit: 25` on a phone (not 50). */
  async memoryRows(
    opts: {
      q?: string;
      topic?: string;
      kind?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<MemoryRowsResponse> {
    const p = new URLSearchParams();
    if (opts.q) p.set("q", opts.q);
    if (opts.topic) p.set("topic", opts.topic);
    if (opts.kind) p.set("kind", opts.kind);
    p.set("limit", String(opts.limit ?? 25));
    p.set("offset", String(opts.offset ?? 0));
    return this.request(`/api/memory/explorer/rows?${p.toString()}`);
  }

  /** The fitted 2-D projection map (scope-filtered, deterministically sampled). */
  async memoryProjection(limit?: number): Promise<MemoryProjection> {
    const qs =
      limit != null ? `?limit=${encodeURIComponent(limit)}` : "";
    return this.request(`/api/memory/explorer/projection${qs}`);
  }

  /** Place a typed query on the map. The text is never persisted upstream. */
  async memoryQuery(text: string): Promise<MemoryQueryPlacement> {
    return this.request("/api/memory/explorer/projection/query", {
      method: "POST",
      json: { text },
    });
  }

  /** The C2-scoped RAG documents list (empty until ingestion runs). */
  async memoryDocuments(): Promise<MemoryDocumentsResponse> {
    return this.request("/api/memory/explorer/documents");
  }

  /** A page of the inbound file registry (arrivals, not memories). */
  async files(
    opts: {
      q?: string;
      surface?: string;
      remembered?: boolean;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<FileAssetsResponse> {
    const p = new URLSearchParams();
    if (opts.q) p.set("q", opts.q);
    if (opts.surface) p.set("surface", opts.surface);
    if (opts.remembered != null) p.set("remembered", String(opts.remembered));
    p.set("limit", String(opts.limit ?? 50));
    p.set("offset", String(opts.offset ?? 0));
    return this.request(`/api/registry/files?${p.toString()}`);
  }

  /** The surfaces the caller actually has files from, with counts. */
  async fileSurfaces(): Promise<FileSurfacesResponse> {
    return this.request("/api/registry/files/surfaces");
  }

  /** One registered file. 404s when it is absent *or* not visible. */
  async file(id: string): Promise<FileAsset> {
    return this.request(`/api/registry/files/${encodeURIComponent(id)}`);
  }

  /** A short-lived signed link to the bytes, minted after the access check. */
  async fileLink(id: string, download = false): Promise<FileLinkResponse> {
    const qs = download ? "?download=true" : "";
    return this.request(
      `/api/registry/files/${encodeURIComponent(id)}/link${qs}`,
    );
  }

  /** Resolve a bucket storage path to the newest visible registry row. */
  async fileByPath(path: string): Promise<FileAsset> {
    return this.request(
      `/api/registry/files/by-path?path=${encodeURIComponent(path)}`,
    );
  }

  /**
   * Record a file agent-home has already written to Storage.
   *
   * agent-home owns the bucket credentials for its own uploads, so it uploads
   * the bytes and posts only where they landed — shipping them twice would
   * double the cost of every attachment.
   */
  async registerFile(payload: {
    filename: string;
    content_type: string;
    byte_size: number;
    sha256: string;
    storage_bucket: string;
    storage_path: string;
    conversation?: string;
    surface?: string;
  }): Promise<FileAsset> {
    return this.request("/api/registry/files/register", {
      method: "POST",
      json: { surface: "agent_home", ...payload },
    });
  }

  /** A keyset page of the unified inbox. */
  async incomings(
    opts: {
      q?: string;
      surface?: string;
      kind?: string;
      sender?: string;
      importance?: string;
      tag?: string;
      tag_match?: string;
      exclude_tag?: string;
      remembered?: boolean;
      has_attachments?: boolean;
      since?: string;
      until?: string;
      limit?: number;
      cursor?: string;
    } = {},
  ): Promise<IncomingsResponse> {
    const p = new URLSearchParams();
    for (const key of [
      "q", "surface", "kind", "sender", "importance", "tag", "tag_match",
      "exclude_tag", "since", "until", "cursor",
    ] as const) {
      const value = opts[key];
      if (value) p.set(key, String(value));
    }
    if (opts.remembered != null) p.set("remembered", String(opts.remembered));
    if (opts.has_attachments != null) {
      p.set("has_attachments", String(opts.has_attachments));
    }
    p.set("limit", String(opts.limit ?? 50));
    return this.request(`/api/registry/incomings?${p.toString()}`);
  }

  /** Surfaces, importance levels and tags the caller actually has. */
  async incomingsFacets(): Promise<IncomingsFacets> {
    return this.request("/api/registry/incomings/facets");
  }

  /** One arrival with its attachments and tags. 404s when not visible. */
  async incoming(id: string): Promise<IncomingDetail> {
    return this.request(`/api/registry/incomings/${encodeURIComponent(id)}`);
  }

  /** Attach a tag from the shared vocabulary, creating it when new. */
  async tagIncoming(
    id: string,
    name: string,
    color?: string,
  ): Promise<SessionTag> {
    return this.request(
      `/api/registry/incomings/${encodeURIComponent(id)}/tags`,
      { method: "POST", json: { name, color } },
    );
  }

  /** Detach a tag. The vocabulary keeps the tag itself. */
  async untagIncoming(id: string, tagId: string): Promise<{ removed: boolean }> {
    return this.request(
      `/api/registry/incomings/${encodeURIComponent(id)}/tags/${encodeURIComponent(tagId)}`,
      { method: "DELETE" },
    );
  }

  /** Ingest an arrival into the memory tier and link it back. */
  async rememberIncoming(id: string): Promise<IncomingItem> {
    return this.request(
      `/api/registry/incomings/${encodeURIComponent(id)}/remember`,
      { method: "POST", json: {} },
    );
  }

  /** A keyset page of to-dos. Snoozed ones are hidden unless asked for. */
  async todos(
    opts: {
      q?: string;
      stage?: string;
      priority?: string;
      source_kind?: string;
      source_ref?: string;
      due_before?: string;
      include_snoozed?: boolean;
      limit?: number;
      cursor?: string;
    } = {},
  ): Promise<TodosResponse> {
    const p = new URLSearchParams();
    for (const key of [
      "q", "stage", "priority", "source_kind", "source_ref", "due_before",
      "cursor",
    ] as const) {
      const value = opts[key];
      if (value) p.set(key, String(value));
    }
    if (opts.include_snoozed) p.set("include_snoozed", "true");
    p.set("limit", String(opts.limit ?? 50));
    return this.request(`/api/registry/todos?${p.toString()}`);
  }

  /** Stages, priorities and sources the caller actually has. */
  async todosFacets(): Promise<TodosFacets> {
    return this.request("/api/registry/todos/facets");
  }

  /** One to-do with its history and the arrival behind it. */
  async todo(id: string): Promise<TodoDetail> {
    return this.request(`/api/registry/todos/${encodeURIComponent(id)}`);
  }

  /** A to-do the user wrote themselves. Lands `open`, never deduped. */
  async createTodo(payload: {
    title: string;
    description?: string;
    priority?: string;
    due_at?: string | null;
  }): Promise<Todo> {
    return this.request("/api/registry/todos", {
      method: "POST",
      json: payload,
    });
  }

  /** Edit the descriptive fields. Lifecycle moves go through `setTodoStage`. */
  async updateTodo(
    id: string,
    payload: {
      title?: string;
      description?: string;
      priority?: string;
      due_at?: string | null;
    },
  ): Promise<Todo> {
    return this.request(`/api/registry/todos/${encodeURIComponent(id)}`, {
      method: "PATCH",
      json: payload,
    });
  }

  /** Promote, start, finish or dismiss — audited with the acting principal. */
  async setTodoStage(
    id: string,
    stage: string,
    outcome?: string,
  ): Promise<Todo> {
    return this.request(`/api/registry/todos/${encodeURIComponent(id)}/stage`, {
      method: "POST",
      json: { stage, outcome },
    });
  }

  /**
   * Finish a to-do, optionally proposing what should leave because of it.
   *
   * The proposal is never a send: it becomes an irreversible approval the user
   * answers themselves.
   */
  async completeTodo(
    id: string,
    payload: { outcome?: string; proposed_action?: ProposedAction } = {},
  ): Promise<TodoCompletion> {
    return this.request(
      `/api/registry/todos/${encodeURIComponent(id)}/complete`,
      { method: "POST", json: payload },
    );
  }

  /** Hide a to-do until `until`, re-arming its notification for then. */
  async snoozeTodo(id: string, until: string): Promise<Todo> {
    return this.request(`/api/registry/todos/${encodeURIComponent(id)}/snooze`, {
      method: "POST",
      json: { until },
    });
  }

  /**
   * Clear a to-do's snooze. Undo passes what the row held before the snooze
   * (`until`: the earlier snooze or null; `notified_at`: the stamp the snooze
   * cleared), so the to-do comes back exactly as it was.
   */
  async unsnoozeTodo(
    id: string,
    restore: { until?: string | null; notified_at?: string | null } = {},
  ): Promise<Todo> {
    return this.request(`/api/registry/todos/${encodeURIComponent(id)}/unsnooze`, {
      method: "POST",
      json: restore,
    });
  }

  /** Move a to-do to `working` and optionally spawn a seeded session. */
  async startTodo(
    id: string,
    payload: { session?: boolean } = {},
  ): Promise<Todo & { session_id?: string | null; spawned?: boolean }> {
    return this.request(`/api/registry/todos/${encodeURIComponent(id)}/start`, {
      method: "POST",
      json: payload,
    });
  }

  /** Promote a to-do into a project card (card lands in `triage`). */
  async promoteTodo(
    id: string,
    payload: { project: string },
  ): Promise<Todo & { card_id?: string; project_id?: string }> {
    return this.request(`/api/registry/todos/${encodeURIComponent(id)}/promote`, {
      method: "POST",
      json: payload,
    });
  }

  /**
   * The entity goal — what every sub-goal ladders into.
   *
   * Creates the default first goal for an owner who has none, so settings is
   * never an empty box with no explanation of what belongs in it.
   */
  async entityGoal(): Promise<EntityGoalResponse> {
    return this.request("/api/registry/goals/entity");
  }

  /** Edit the entity goal. Owner only, and effective in the next session. */
  async updateEntityGoal(payload: {
    title?: string;
    description?: string;
  }): Promise<EntityGoalResponse> {
    return this.request("/api/registry/goals/entity", {
      method: "PATCH",
      json: payload,
    });
  }

  // ── Projects (design ed.3.2 §12 — BFF mirror of /api/registry/projects) ──

  /** The readable projects, newest first, with derived progress + health. */
  async projects(
    opts: {
      status?: string;
      cadence?: string;
      health?: string;
      q?: string;
      archived?: boolean;
      limit?: number;
      cursor?: string;
      /** Comma-separated category ids, "none" for Uncategorized. */
      category?: string;
      /** created | completed | due | name | status | duration | tokens */
      sort?: string;
      order?: string;
    } = {},
  ): Promise<ProjectsResponse> {
    const p = new URLSearchParams();
    for (const key of ["status", "cadence", "health", "q", "category", "sort", "order", "cursor"] as const) {
      const value = opts[key];
      if (value) p.set(key, String(value));
    }
    if (opts.archived) p.set("archived", "true");
    if (opts.limit !== undefined) p.set("limit", String(opts.limit));
    const qs = p.toString();
    return this.request(`/api/registry/projects${qs ? `?${qs}` : ""}`);
  }

  /** Running kanban cards across the caller's active projects (status strip). */
  async projectsPinnedModels(): Promise<{ pinned: PinnedModelCard[] }> {
    return this.request("/api/registry/projects/pinned-models");
  }

  async projectsRunningCards(): Promise<{ running_cards: number }> {
    return this.request("/api/registry/projects/running-cards");
  }

  /** Chats, project runs, cards and cron jobs running now (activity bar). */
  async activityRunning(): Promise<ActivityItem[]> {
    return this.request("/api/activity/running");
  }

  /** The instance's project categories, in column order, with project counts. */
  async projectCategories(): Promise<ProjectCategoriesResponse> {
    return this.request("/api/registry/project-categories");
  }

  /** Add a category (name unique, case-insensitive; a duplicate is a 409). */
  async createProjectCategory(payload: {
    name: string;
    color?: string | null;
  }): Promise<ProjectCategory> {
    return this.request("/api/registry/project-categories", {
      method: "POST",
      json: payload,
    });
  }

  /** Rename / recolour / reorder a category. */
  async updateProjectCategory(
    id: string,
    payload: { name?: string; color?: string | null; position?: number },
  ): Promise<ProjectCategory> {
    return this.request(
      `/api/registry/project-categories/${encodeURIComponent(id)}`,
      { method: "PATCH", json: payload },
    );
  }

  /** Delete a category; its projects fall back to Uncategorized. */
  async deleteProjectCategory(
    id: string,
  ): Promise<{ deleted: string; uncategorized: number }> {
    return this.request(
      `/api/registry/project-categories/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  }

  /** Diagnosable breaks across readable projects (§15.1), or one slug's. */
  async projectsDoctor(slug?: string): Promise<ProjectsDoctorResponse> {
    const qs = slug ? `?slug=${encodeURIComponent(slug)}` : "";
    return this.request(`/api/registry/projects/doctor${qs}`);
  }

  /** Create under the full §2.2 contract — goal, description, an output, host profile. */
  async createProject(payload: CreateProjectPayload): Promise<Project & { created: boolean }> {
    return this.request("/api/registry/projects", {
      method: "POST",
      json: payload,
    });
  }

  /** Task mode's Start task: a one-off project that plans and starts itself. */
  async createQuickTask(payload: QuickTaskPayload): Promise<QuickTaskResponse> {
    return this.request("/api/registry/projects/quick-task", {
      method: "POST",
      json: payload,
    });
  }

  /** Carry a task on: approve its proposed plan and start, retry, or redraft. */
  async startQuickTask(slug: string): Promise<QuickTaskStartResponse> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/quick-task/start`,
      { method: "POST", json: {} },
    );
  }

  /** The whole record in one read: fields, outputs, people, links, runs, health. */
  async project(slug: string): Promise<ProjectDetail> {
    return this.request(`/api/registry/projects/${encodeURIComponent(slug)}`);
  }

  /** Edit record fields. Leaving `repeatable` pauses + detaches the schedule (§3.1). */
  async updateProject(
    slug: string,
    payload: Record<string, unknown>,
  ): Promise<Project> {
    return this.request(`/api/registry/projects/${encodeURIComponent(slug)}`, {
      method: "PATCH",
      json: payload,
    });
  }

  /** Shelve it (§13): the archived flag and status land in one call, the
   * schedule detaches by the same call. Answers the updated row, never an
   * ack — the list merges it. */
  async archiveProject(slug: string, reason?: string): Promise<Project> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/archive`,
      { method: "POST", json: reason ? { reason } : {} },
    );
  }

  /** Bring a shelved project back — lands in `paused`, never `active`, and
   * the schedule is not resurrected (§12). Answers the updated row. */
  async restoreProject(slug: string): Promise<Project> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/restore`,
      { method: "POST", json: {} },
    );
  }

  /** Hard delete — the narrow exception (decision 17): human-only upstream,
   * `confirm` must equal the slug, and a 409 names what history the record
   * still carries. `purge: "smoke"` asks for the test-data purge instead:
   * an archived `[smoke]` project the caller created goes with its runs,
   * cards and run sessions; upstream refuses any other project. */
  async deleteProject(
    slug: string,
    confirm: string,
    opts: { purge?: string } = {},
  ): Promise<{ deleted: string; purged?: { runs: number; cards: number; sessions: number } }> {
    const purge = opts.purge === undefined ? "" : `&purge=${encodeURIComponent(opts.purge)}`;
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}?confirm=${encodeURIComponent(confirm)}${purge}`,
      { method: "DELETE" },
    );
  }

  /** Autonomy gets its own route so the audit line is unmistakable (§12). */
  async setProjectAutonomy(
    slug: string,
    autonomy: string,
  ): Promise<{ slug: string; autonomy: string }> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/autonomy`,
      { method: "PATCH", json: { autonomy } },
    );
  }

  /** Create or update the host profile's cron job (§3.2). Lead only. */
  async setProjectSchedule(
    slug: string,
    schedule: string,
  ): Promise<ProjectScheduleResult> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/schedule`,
      { method: "PUT", json: { schedule } },
    );
  }

  /** Remove the schedule: both halves of the link go (§3.2). */
  async clearProjectSchedule(
    slug: string,
  ): Promise<{ scheduled: false; removed: boolean }> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/schedule`,
      { method: "DELETE" },
    );
  }

  /** One project's doctor: the findings and the health they imply. */
  async projectDoctor(slug: string): Promise<ProjectDoctorDetail> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/doctor`,
    );
  }

  /** The project's cards, column-grouped through the shared rollup. */
  async projectBoard(slug: string): Promise<ProjectBoardView> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/board`,
    );
  }

  /** §12: the live-update event tail — pass the previous `latest_event_id`. */
  async projectEvents(
    slug: string,
    since?: number,
  ): Promise<ProjectEventsResponse> {
    const query = since != null ? `?since=${encodeURIComponent(since)}` : "";
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/events${query}`,
    );
  }

  /** §2.2: write the rolling "where this stands" summary (§17 step 11). */
  async summariseProject(
    slug: string,
    summary: string,
  ): Promise<{ summary: string; summary_at: number }> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/summarise`,
      { method: "POST", json: { summary } },
    );
  }

  /** Create a card carrying the project id — lands in `triage` (§10). */
  async createProjectCard(
    slug: string,
    payload: {
      title?: string;
      body?: string;
      assignee?: string;
      from_todo?: { profile?: string; id: string };
    },
  ): Promise<{
    task_id: string;
    project_id: string;
    status: string;
    from_todo?: { profile: string; id: string };
  }> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/cards`,
      { method: "POST", json: payload },
    );
  }

  /**
   * `PATCH /{slug}/cards/{task_id}` — hand-edit a card: title / body /
   * assignee (null unassigns) / status (a column move). Judgement act.
   */
  async updateProjectCard(
    slug: string,
    taskId: string,
    payload: {
      title?: string;
      body?: string;
      assignee?: string | null;
      status?: string;
    },
  ): Promise<ProjectCardDetail> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/cards/${encodeURIComponent(taskId)}`,
      { method: "PATCH", json: payload },
    );
  }

  /** One card, re-checked under the caller's principal. */
  /** What a short ref (`P12`, `T345`, `P12-R3`) names — 404 when hidden. */
  async resolveRef(ref: string): Promise<RefResolution> {
    return this.request(`/api/refs/${encodeURIComponent(ref)}`);
  }

  async projectCard(
    slug: string,
    taskId: string,
  ): Promise<ProjectCardDetail> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/cards/${encodeURIComponent(taskId)}`,
    );
  }

  /** Stop a stuck worker and re-queue the card (dispatcher respawns). */
  async reclaimProjectCard(
    slug: string,
    taskId: string,
  ): Promise<{ ok: boolean; task_id: string }> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/cards/${encodeURIComponent(taskId)}/reclaim`,
      { method: "POST" },
    );
  }

  /** Halt the card without a re-run (parks it in blocked). */
  async stopProjectCard(
    slug: string,
    taskId: string,
  ): Promise<{ ok: boolean; task_id: string }> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/cards/${encodeURIComponent(taskId)}/stop`,
      { method: "POST" },
    );
  }

  /** Add a deliverable [3]. */
  async addProjectOutput(
    slug: string,
    payload: {
      title: string;
      spec?: string;
      kind?: string;
      required?: boolean;
      recurring?: boolean;
    },
  ): Promise<ProjectOutput> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/outputs`,
      { method: "POST", json: payload },
    );
  }

  /** Patch an output. Flipping `required` is lead-only upstream. */
  async updateProjectOutput(
    slug: string,
    outputId: string,
    payload: Record<string, unknown>,
  ): Promise<ProjectOutput> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/outputs/${encodeURIComponent(outputId)}`,
      { method: "PATCH", json: payload },
    );
  }

  /** Delete an output — refuses on the last required one. */
  async deleteProjectOutput(
    slug: string,
    outputId: string,
  ): Promise<{ deleted: string }> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/outputs/${encodeURIComponent(outputId)}`,
      { method: "DELETE" },
    );
  }

  /** Record a delivery (run, card, or a hand-attached artefact). */
  async deliverProjectOutput(
    slug: string,
    outputId: string,
    payload: {
      run_id?: string;
      task_id?: string;
      link_kind?: string;
      link_ref?: string;
      profile?: string;
      label?: string;
      note?: string;
    } = {},
  ): Promise<{ delivery_id: string; output_id: string; by: string }> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/outputs/${encodeURIComponent(outputId)}/deliver`,
      { method: "POST", json: payload },
    );
  }

  /** Human-only acceptance (§6.1); offers closure on the last required output. */
  async acceptProjectOutput(
    slug: string,
    outputId: string,
  ): Promise<{ accepted: string; by: string; offers_closure: boolean }> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/outputs/${encodeURIComponent(outputId)}/accept`,
      { method: "POST", json: {} },
    );
  }

  /** Add a member (a person) to the project. */
  async addProjectMember(
    slug: string,
    payload: { user_id: string; role?: string },
  ): Promise<{ user_id: string; role: string }> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/members`,
      { method: "POST", json: payload },
    );
  }

  /** Remove a member — refuses on the last lead. */
  async removeProjectMember(
    slug: string,
    userId: string,
  ): Promise<{ removed: string }> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/members/${encodeURIComponent(userId)}`,
      { method: "DELETE" },
    );
  }

  /** Attach an instrument (profile) the project runs on. */
  async addProjectProfile(
    slug: string,
    payload: { profile: string; role?: string },
  ): Promise<{ profile: string }> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/profiles`,
      { method: "POST", json: payload },
    );
  }

  /** Detach a profile — refuses on the last one. */
  async removeProjectProfile(
    slug: string,
    name: string,
  ): Promise<{ detached: string }> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/profiles/${encodeURIComponent(name)}`,
      { method: "DELETE" },
    );
  }

  /** Add a contact [10]. */
  async addProjectContact(
    slug: string,
    payload: {
      name: string;
      role?: string;
      org?: string;
      platform?: string;
      address?: string;
      user_id?: string;
      notes?: string;
    },
  ): Promise<ProjectContact> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/contacts`,
      { method: "POST", json: payload },
    );
  }

  /** Patch a contact's fields. */
  async updateProjectContact(
    slug: string,
    contactId: string,
    payload: Record<string, unknown>,
  ): Promise<ProjectContact> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/contacts/${encodeURIComponent(contactId)}`,
      { method: "PATCH", json: payload },
    );
  }

  /** Delete a contact. */
  async deleteProjectContact(
    slug: string,
    contactId: string,
  ): Promise<{ deleted: string }> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/contacts/${encodeURIComponent(contactId)}`,
      { method: "DELETE" },
    );
  }

  /** Attach a pointer (§11 rule 5): file, arrival, to-do, goal, memory, URL… */
  async linkToProject(
    slug: string,
    payload: {
      kind: string;
      ref: string;
      profile?: string;
      label?: string;
    },
  ): Promise<ProjectLink> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/links`,
      { method: "POST", json: payload },
    );
  }

  /** Detach a pointer. */
  async unlinkFromProject(
    slug: string,
    payload: { kind: string; ref: string; profile?: string },
  ): Promise<{ detached: { kind: string; profile: string; ref: string } }> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/links`,
      { method: "DELETE", json: payload },
    );
  }

  /** The method: active revision + all revisions (§7). */
  async projectPlaybook(slug: string): Promise<ProjectPlaybookResponse> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/playbook`,
    );
  }

  /** Profiles the caller may assign plan steps to, with what each can do (FG-34 C-2). */
  async projectAssignableProfiles(slug: string): Promise<AssignableProfilesResponse> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/assignable-profiles`,
    );
  }

  /** Propose revision N+1 (inactive). Cycle-checked; assignees must be profiles. */
  async saveProjectPlaybook(
    slug: string,
    payload: { body?: string; steps: unknown[]; note?: string; base_rev?: number },
  ): Promise<{ rev: number; active: false }> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/playbook`,
      { method: "POST", json: payload },
    );
  }

  /** Ask the agent to draft a proposed revision from the brief; runs
   *  server-side, poll `projectPlaybookDraft` for the outcome. */
  async draftProjectPlaybook(slug: string): Promise<ProjectPlaybookDraftState> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/playbook/draft`,
      { method: "POST", json: {} },
    );
  }

  async projectPlaybookDraft(slug: string): Promise<ProjectPlaybookDraftState> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/playbook/draft`,
    );
  }

  /** Human-only activation (§7.2) — lead/admin. */
  async activateProjectPlaybook(
    slug: string,
    rev: number,
    note?: string,
  ): Promise<{ rev: number; active: true }> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/playbook/${encodeURIComponent(rev)}/activate`,
      { method: "POST", json: note ? { note } : {} },
    );
  }

  /** Discard a proposed revision — the paired judgement to activation.
   *  Refused (409) for the active rev or one a run has pinned. */
  async discardProjectPlaybook(
    slug: string,
    rev: number,
  ): Promise<{ rev: number; discarded: true }> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/playbook/${encodeURIComponent(rev)}`,
      { method: "DELETE" },
    );
  }

  /** Standing instructions + feedback (§5). */
  async projectDirectives(
    slug: string,
    opts: { includeRetired?: boolean } = {},
  ): Promise<ProjectDirectivesResponse> {
    const qs = opts.includeRetired ? "?include_retired=true" : "";
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/directives${qs}`,
    );
  }

  /** Add guidance — applies from the next run, never mid-conversation. */
  async addProjectDirective(
    slug: string,
    payload: {
      kind?: string;
      body: string;
      scope?: string;
      target_ref?: string;
      rating?: string;
    },
  ): Promise<{ id: string; applies_from: string }> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/directives`,
      { method: "POST", json: payload },
    );
  }

  /** Retire, never delete (§5.2). */
  async retireProjectDirective(
    slug: string,
    directiveId: string,
  ): Promise<{ id: string; retired: true }> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/directives/${encodeURIComponent(directiveId)}/retire`,
      { method: "POST", json: {} },
    );
  }

  /** §8.2: a member activates a proposed directive — applies next run. */
  async activateProjectDirective(
    slug: string,
    directiveId: string,
  ): Promise<{ id: string; active: true; applies_from: string }> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/directives/${encodeURIComponent(directiveId)}/activate`,
      { method: "POST", json: {} },
    );
  }

  /** The record: every run with duration, outcome, deliveries, scores. */
  async projectRuns(slug: string): Promise<{ runs: ProjectRun[] }> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/runs`,
    );
  }

  /** One run's cards, deliveries, cost (fail-open) and retro. */
  async projectRun(slug: string, runNo: number): Promise<ProjectRun> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/runs/${encodeURIComponent(runNo)}`,
    );
  }

  /** Start a run now (`trigger='manual'`); `playbook_rev` repeats an old method. */
  async startProjectRun(
    slug: string,
    payload: { playbook_rev?: number } = {},
  ): Promise<ProjectRun> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/runs`,
      { method: "POST", json: payload },
    );
  }

  /** Pass a checkpoint / answer a budget stop (§12). */
  async continueProjectRun(slug: string, runNo: number): Promise<ProjectRun> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/runs/${encodeURIComponent(runNo)}/continue`,
      { method: "POST", json: {} },
    );
  }

  /** Stop promoting and archive un-started cards; never kills a worker. */
  async cancelProjectRun(slug: string, runNo: number): Promise<ProjectRun> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/runs/${encodeURIComponent(runNo)}/cancel`,
      { method: "POST", json: {} },
    );
  }

  /**
   * Continue a `failed`/`cancelled` run from wherever its cards already
   * are — distinct from `startProjectRun` ("Repeat this run"), which
   * starts a brand-new run on the same method and redoes every step.
   */
  async resumeProjectRun(slug: string, runNo: number): Promise<ProjectRun> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/runs/${encodeURIComponent(runNo)}/resume`,
      { method: "POST", json: {} },
    );
  }

  /**
   * The run's live reasoning and tool activity as raw SSE, for the BFF to
   * pipe. `after` resumes from a sequence number so a reconnect replays what
   * it missed. Like `openChatStream`, the body is NOT consumed here.
   */
  async openRunActivityStream(
    slug: string,
    runNo: number,
    after: number,
  ): Promise<Response> {
    const headers = new Headers({ accept: "text/event-stream" });
    if (this.hermesToken) {
      headers.set("cookie", `hermes_session_at=${this.hermesToken}`);
      headers.set("authorization", `Bearer ${this.hermesToken}`);
    }
    const res = await fetch(
      `${this.baseUrl}/api/registry/projects/${encodeURIComponent(slug)}/runs/${encodeURIComponent(runNo)}/activity?after=${encodeURIComponent(after)}`,
      { headers, cache: "no-store" },
    );
    if (!res.ok || !res.body) {
      const text = res.body ? await res.text().catch(() => "") : "";
      throw new HermesApiError(
        res.status,
        upstreamDetail(
          text ? safeJson(text) : undefined,
          "That run has no activity to show.",
        ),
        text,
      );
    }
    return res;
  }

  /**
   * The run row itself, pushed live (§12 push edition) instead of the
   * browser polling `projectRun` on a timer: the same payload, re-sent
   * only when it actually changes, ending once the run is terminal. Raw
   * SSE for the BFF to pipe, like `openRunActivityStream`.
   */
  async openRunStream(slug: string, runNo: number): Promise<Response> {
    return this._openRowStream(
      `/api/registry/projects/${encodeURIComponent(slug)}/runs/${encodeURIComponent(runNo)}/stream`,
      "That run could not be found.",
    );
  }

  /**
   * One card's row, pushed live while a worker is on it — same payload as
   * `projectCard`, ending once the card leaves `running`.
   */
  async openCardStream(slug: string, taskId: string): Promise<Response> {
    return this._openRowStream(
      `/api/registry/projects/${encodeURIComponent(slug)}/cards/${encodeURIComponent(taskId)}/stream`,
      "That card could not be found.",
    );
  }

  /**
   * The project's event cursor, pushed live instead of the project page
   * polling `projectEvents` on a timer. Never ends on its own — the
   * project has no terminal state — so the caller tears the connection
   * down on unmount.
   */
  async openProjectEventsStream(slug: string): Promise<Response> {
    return this._openRowStream(
      `/api/registry/projects/${encodeURIComponent(slug)}/events/stream`,
      "That project could not be found.",
    );
  }

  /** Shared opener behind `openRunStream` / `openCardStream` /
   * `openProjectEventsStream`: same auth headers and error shape as
   * `openRunActivityStream`, the body is NOT consumed here. */
  private async _openRowStream(
    path: string,
    notFoundDetail: string,
  ): Promise<Response> {
    const headers = new Headers({ accept: "text/event-stream" });
    if (this.hermesToken) {
      headers.set("cookie", `hermes_session_at=${this.hermesToken}`);
      headers.set("authorization", `Bearer ${this.hermesToken}`);
    }
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers,
      cache: "no-store",
    });
    if (!res.ok || !res.body) {
      const text = res.body ? await res.text().catch(() => "") : "";
      throw new HermesApiError(
        res.status,
        upstreamDetail(text ? safeJson(text) : undefined, notFoundDetail),
        text,
      );
    }
    return res;
  }

  /** Stop the run now: terminate live workers, then close it. */
  async stopProjectRun(slug: string, runNo: number): Promise<ProjectRun> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/runs/${encodeURIComponent(runNo)}/stop`,
      { method: "POST", json: {} },
    );
  }

  /** Write or edit the retrospective. */
  async writeProjectRetro(
    slug: string,
    runNo: number,
    retro: string,
  ): Promise<ProjectRun> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/runs/${encodeURIComponent(runNo)}/retro`,
      { method: "POST", json: { retro } },
    );
  }

  /** §8.1: score a run 1–5 — human-only, editable, never agent-writable. */
  async scoreProjectRun(
    slug: string,
    runNo: number,
    payload: { score: number; note?: string },
  ): Promise<{
    scored: number;
    score_user: number;
    score_note: string | null;
    by: string;
  }> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/runs/${encodeURIComponent(runNo)}/score`,
      { method: "POST", json: payload },
    );
  }

  /** Set toolsets/skills; returns the resolved host-profile intersection (§4.1). */
  async setProjectTools(
    slug: string,
    payload: { toolsets?: string[]; skills?: string[] },
  ): Promise<ProjectToolsResolution> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/tools`,
      { method: "PATCH", json: payload },
    );
  }

  // -- unified credential store (Settings → Connected accounts) ------------

  /** The caller's readable credential entries, redacted. */
  async credentials(): Promise<{ credentials: CredentialEntry[] }> {
    return this.request("/api/credentials");
  }

  async credential(
    provider: string,
    name: string,
  ): Promise<{ credential: CredentialEntry }> {
    return this.request(
      `/api/credentials/${encodeURIComponent(provider)}/${encodeURIComponent(name)}`,
    );
  }

  /** Toggle services / visibility on an entry the caller owns. */
  async patchCredential(
    provider: string,
    name: string,
    payload: { services?: string[]; visibility?: string },
  ): Promise<{ credential: CredentialEntry }> {
    return this.request(
      `/api/credentials/${encodeURIComponent(provider)}/${encodeURIComponent(name)}`,
      { method: "PATCH", json: payload },
    );
  }

  /** The caller's own Telegram bot (`/api/telegram-bot`); never the token. */
  async telegramBot(): Promise<TelegramBotView> {
    return this.request("/api/telegram-bot");
  }

  async saveTelegramBot(token: string): Promise<TelegramBotView> {
    return this.request("/api/telegram-bot", { method: "PUT", json: { token } });
  }

  async removeTelegramBot(): Promise<TelegramBotView> {
    return this.request("/api/telegram-bot", { method: "DELETE" });
  }

  async telegramBotAction(
    action: TelegramBotAction,
    method: "POST" | "DELETE" = "POST",
  ): Promise<TelegramBotView> {
    return this.request(`/api/telegram-bot/${action}`, { method });
  }

  async deleteCredential(
    provider: string,
    name: string,
  ): Promise<{ deleted: boolean }> {
    return this.request(
      `/api/credentials/${encodeURIComponent(provider)}/${encodeURIComponent(name)}`,
      { method: "DELETE" },
    );
  }

  /** Create or replace an entry (`PUT /api/credentials/{provider}/{name}`). */
  async putCredential(
    provider: string,
    name: string,
    body: {
      kind: string;
      payload: Record<string, unknown>;
      visibility?: string;
      services?: string[];
    },
  ): Promise<{ credential: CredentialEntry }> {
    return this.request(
      `/api/credentials/${encodeURIComponent(provider)}/${encodeURIComponent(name)}`,
      { method: "PUT", json: body },
    );
  }

  // -- offsite backups (Get ready item 10, owner only) ----------------------

  /** Offsite backup status: target without secrets, progress, last results. */
  async offsiteBackup(): Promise<OffsiteBackupStatus> {
    return this.request("/api/backups/offsite");
  }

  /** Check the storage with this key and save it; `new_key` only the first time. */
  async configureOffsiteBackup(
    settings: Record<string, unknown>,
  ): Promise<{ status: OffsiteBackupStatus; new_key?: string }> {
    return this.request("/api/backups/offsite", { method: "PUT", json: settings });
  }

  /** Stop offsite backups; copies already in storage stay. */
  async removeOffsiteBackup(): Promise<OffsiteBackupStatus> {
    return this.request("/api/backups/offsite", { method: "DELETE" });
  }

  async offsiteBackupAction(
    action: "test" | "run" | "restore-test",
  ): Promise<OffsiteBackupStatus | { started: boolean; status: OffsiteBackupStatus }> {
    return this.request(`/api/backups/offsite/${action}`, { method: "POST" });
  }

  // -- software upgrade (Settings → Software upgrade; owner and admins) -----

  async softwareUpgrade(): Promise<SoftwareUpgradeStatus> {
    return this.request("/api/software-upgrade");
  }

  /** Progress poll: status without the release list. */
  async softwareUpgradeJob(): Promise<SoftwareUpgradeStatus> {
    return this.request("/api/software-upgrade/job");
  }

  async checkSoftwareUpgrade(): Promise<SoftwareUpgradeStatus> {
    return this.request("/api/software-upgrade/check", { method: "POST" });
  }

  async startSoftwareUpgrade(body: {
    version: string;
    password: string;
  }): Promise<{ started: boolean; status: SoftwareUpgradeStatus }> {
    return this.request("/api/software-upgrade/start", { method: "POST", json: body });
  }

  async rollbackSoftwareUpgrade(body: {
    password: string;
  }): Promise<{ started: boolean; status: SoftwareUpgradeStatus }> {
    return this.request("/api/software-upgrade/rollback", { method: "POST", json: body });
  }

  // -- private networks (Settings → In&Out → Fortinet VPN) -----------------

  /** The caller's readable fortinet-vpn entries with live tunnel status. */
  async vpns(): Promise<{ vpns: VpnView[] }> {
    return this.request("/api/vpn");
  }

  /** Get ready → Security basics: the last saved result (owner/admin). */
  async securityBasics(): Promise<SecurityBasicsResult> {
    return this.request("/api/security-basics");
  }

  /** Run the read-only security checks now (owner/admin; up to ~3 min). */
  async testSecurityBasics(): Promise<SecurityBasicsResult> {
    return this.request("/api/security-basics/test", { method: "POST" });
  }

  /** Connect / disconnect / test a VPN. Connection failures come back as
   *  200 with `status.state == "error"`, not as an HTTP error. */
  async vpnAction(
    name: string,
    action: "connect" | "disconnect" | "test",
  ): Promise<{ vpn: VpnView }> {
    return this.request(
      `/api/vpn/${encodeURIComponent(name)}/${action}`,
      { method: "POST" },
    );
  }

  /** Trust the gateway certificate with this SHA-256, then connect. */
  async trustVpnCert(name: string, sha256: string): Promise<{ vpn: VpnView }> {
    return this.request(`/api/vpn/${encodeURIComponent(name)}/trust`, {
      method: "POST",
      json: { sha256 },
    });
  }

  // -- network folders (Files → Bridge → through a VPN) ---------------------

  /** The caller's own network folders with mount / VPN status. */
  async networkFolders(): Promise<{ folders: NetworkFolderView[] }> {
    return this.request("/api/vpn/folders");
  }

  async createNetworkFolder(body: NetworkFolderInput): Promise<NetworkFolderView> {
    return this.request("/api/vpn/folders", { method: "POST", json: body });
  }

  /** Replace a network folder; `body.name` may rename it. */
  async updateNetworkFolder(
    name: string,
    body: NetworkFolderInput,
  ): Promise<NetworkFolderView> {
    return this.request(`/api/vpn/folders/${encodeURIComponent(name)}`, {
      method: "PUT",
      json: body,
    });
  }

  /** Unmount and delete a network folder. */
  async deleteNetworkFolder(name: string): Promise<{ ok: boolean }> {
    return this.request(`/api/vpn/folders/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
  }

  /** `test` connects the VPN if needed, mounts and counts files (result in
   *  `status.last_check`); `disconnect` unmounts only, the VPN stays up. */
  async networkFolderAction(
    name: string,
    action: "test" | "disconnect",
  ): Promise<NetworkFolderView> {
    return this.request(
      `/api/vpn/folders/${encodeURIComponent(name)}/${action}`,
      { method: "POST" },
    );
  }

  // -- Files → Browse (network folders + own workspace, read-only) -----------

  /** Places the caller may browse: readable network folders, then their workspace. */
  async browsePlaces(): Promise<{ places: BrowsePlace[] }> {
    return this.request("/api/browse/places");
  }

  /** One folder level of a place (`path` relative to it, `""` for the top). */
  async browseList(place: string, path: string): Promise<BrowseListing> {
    const qs = new URLSearchParams({ place, path });
    return this.request(`/api/browse/list?${qs.toString()}`);
  }

  /** Copy one file into the caller's own Files (Storage + registry). */
  async browseSave(place: string, path: string): Promise<BrowseSaveResult> {
    return this.request("/api/browse/save", { method: "POST", json: { place, path } });
  }

  /** The file's bytes as an unconsumed upstream response. */
  async browseFile(place: string, path: string): Promise<Response> {
    const qs = new URLSearchParams({ place, path });
    const headers = new Headers();
    if (this.hermesToken) {
      headers.set("cookie", `hermes_session_at=${this.hermesToken}`);
      headers.set("authorization", `Bearer ${this.hermesToken}`);
    }
    const res = await fetch(`${this.baseUrl}${this.scopedPath(`/api/browse/file?${qs.toString()}`)}`, {
      headers,
      cache: "no-store",
    });
    if (!res.ok || !res.body) {
      const text = res.body ? await res.text().catch(() => "") : "";
      throw new HermesApiError(
        res.status,
        upstreamDetail(text ? safeJson(text) : undefined, "That file could not be opened."),
        text,
      );
    }
    return res;
  }

  /** Email-poller account flags (deployment poller config; owner-gated). */
  async emailAccounts(): Promise<{
    config_present: boolean;
    accounts: EmailPollerAccount[];
  }> {
    return this.request("/api/email-accounts");
  }

  /** Enable/disable polling for an address; creates a Gmail entry (or, with
   *  auth "password", an entry for the owner's saved IMAP/SMTP mailbox) when
   *  enabling an address the poller doesn't know yet. */
  async setEmailPolling(
    address: string,
    enabled: boolean,
    auth?: "xoauth2" | "password",
  ): Promise<{ account: EmailPollerAccount }> {
    return this.request("/api/email-accounts", {
      method: "PATCH",
      json: auth ? { address, enabled, auth } : { address, enabled },
    });
  }

  /** The caller's own IMAP/SMTP mailboxes (never any password). */
  async emailMailboxes(): Promise<{
    mailboxes: EmailMailbox[];
    presets: Record<string, EmailServerSettings>;
  }> {
    return this.request("/api/email/mailboxes");
  }

  /** Create or replace the caller's mailbox; an empty password keeps it. */
  async putEmailMailbox(
    address: string,
    body: EmailMailboxInput,
  ): Promise<{ mailbox: EmailMailbox }> {
    return this.request(`/api/email/mailboxes/${encodeURIComponent(address)}`, {
      method: "PUT",
      json: body,
    });
  }

  async deleteEmailMailbox(address: string): Promise<{ deleted: boolean }> {
    return this.request(`/api/email/mailboxes/${encodeURIComponent(address)}`, {
      method: "DELETE",
    });
  }

  /** Log into IMAP and SMTP with the saved settings (no mail is sent). */
  async testEmailMailbox(address: string): Promise<{ mailbox: EmailMailbox }> {
    return this.request(
      `/api/email/mailboxes/${encodeURIComponent(address)}/test`,
      { method: "POST" },
    );
  }

  /** The caller's own SQL Server connections (never any password). */
  async mssqlConnections(): Promise<{ connections: MssqlConnection[]; driver_available: boolean }> {
    return this.request("/api/mssql/connections");
  }

  /** Create or replace the caller's connection; an empty password keeps it. */
  async putMssqlConnection(
    name: string,
    body: MssqlConnectionInput,
  ): Promise<{ connection: MssqlConnection }> {
    return this.request(`/api/mssql/connections/${encodeURIComponent(name)}`, {
      method: "PUT",
      json: body,
    });
  }

  async deleteMssqlConnection(name: string): Promise<{ deleted: boolean }> {
    return this.request(`/api/mssql/connections/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
  }

  /** Sign in with the saved settings and read the server version. */
  async testMssqlConnection(name: string): Promise<{ connection: MssqlConnection }> {
    return this.request(
      `/api/mssql/connections/${encodeURIComponent(name)}/test`,
      { method: "POST" },
    );
  }

  /** The caller's own Windows servers (PowerShell over WinRM; never any password). */
  async winrmConnections(): Promise<{ connections: WinrmConnection[]; driver_available: boolean }> {
    return this.request("/api/winrm/connections");
  }

  /** Create or replace the caller's Windows server; an empty password keeps it. */
  async putWinrmConnection(
    name: string,
    body: WinrmConnectionInput,
  ): Promise<{ connection: WinrmConnection }> {
    return this.request(`/api/winrm/connections/${encodeURIComponent(name)}`, {
      method: "PUT",
      json: body,
    });
  }

  async deleteWinrmConnection(name: string): Promise<{ deleted: boolean }> {
    return this.request(`/api/winrm/connections/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
  }

  /** Sign in with the saved settings and read the PowerShell version and computer name. */
  async testWinrmConnection(name: string): Promise<{ connection: WinrmConnection }> {
    return this.request(
      `/api/winrm/connections/${encodeURIComponent(name)}/test`,
      { method: "POST" },
    );
  }

  /** WhatsApp bridge units (deployment sidecars; owner-gated). */
  async waBridges(): Promise<WaBridgesResponse> {
    return this.request("/api/wa-bridges");
  }

  /** "Send yourself a test": one message to the bridge's own number. */
  async waBridgeTest(name: string): Promise<{ sent: boolean; to: string | null }> {
    return this.request(
      `/api/wa-bridges/${encodeURIComponent(name)}/test`,
      { method: "POST" },
    );
  }

  /** Pending pairing payload for an unpaired bridge (auth material). */
  async waBridgeQr(name: string): Promise<{
    payload: string;
    age_seconds: number;
    stale: boolean;
  }> {
    return this.request(
      `/api/wa-bridges/${encodeURIComponent(name)}/qr`,
    );
  }

  /** restart | stop | rebind (wipe session + restart for a fresh QR). */
  async waBridgeAction(
    name: string,
    action: "restart" | "stop" | "rebind",
  ): Promise<{ bridge: WaBridge }> {
    return this.request(
      `/api/wa-bridges/${encodeURIComponent(name)}/${action}`,
      { method: "POST" },
    );
  }

  /** Provision a new hermes-wa-bridge-<name> unit (needs host sudo grant). */
  async waBridgeAdd(name: string): Promise<{ bridge: WaBridge }> {
    return this.request("/api/wa-bridges", {
      method: "POST",
      json: { name },
    });
  }

  /** Google step A status: is an install-wide OAuth client saved (owner only). */
  async googleClientStatus(): Promise<GoogleClientStatus> {
    return this.request("/api/google-client");
  }

  /** Save + check the install's Google OAuth client (owner only). */
  async saveGoogleClient(payload: {
    client_json?: string;
    client_id?: string;
    client_secret?: string;
    replace?: boolean;
  }): Promise<GoogleClientSaveResult> {
    return this.request("/api/google-client", { method: "PUT", json: payload });
  }

  /** Ask Google whether the saved client is still accepted (owner only). */
  async testGoogleClient(): Promise<{
    check: GoogleClientCheck;
    client: GoogleClientStatus;
  }> {
    return this.request("/api/google-client/test", { method: "POST" });
  }

  /** Store the owner's ticks for Google step A, steps 1–5 (owner only). */
  async saveGoogleClientSteps(
    steps: Partial<GoogleClientStatus["steps"]>,
  ): Promise<GoogleClientStatus> {
    return this.request("/api/google-client/steps", {
      method: "PUT",
      json: { steps },
    });
  }

  /** Begin a Google OAuth connect; returns the consent URL to open. */
  async googleStart(payload: {
    name?: string;
    services: string[];
  }): Promise<{ auth_url: string; state: string; expires_in?: number }> {
    return this.request("/api/credentials/google/start", {
      method: "POST",
      json: payload,
    });
  }

  /** Finish the connect with the pasted code or redirect URL. */
  async googleComplete(payload: { code_or_url: string }): Promise<{
    credential: CredentialEntry;
    account_email: string | null;
    granted_scopes: string[];
  }> {
    return this.request("/api/credentials/google/complete", {
      method: "POST",
      json: payload,
    });
  }

  async googleRefresh(name: string): Promise<{
    refreshed: boolean;
    write_won: boolean;
  }> {
    return this.request(
      `/api/credentials/google/${encodeURIComponent(name)}/refresh`,
      { method: "POST" },
    );
  }

  // ── Models page (System ▸ Models) ─────────────────────────────────────
  // Thin forwards to the same `/api/model/*` endpoints the dashboard's
  // Models Settings screen uses. Writes apply to new sessions only —
  // upstream owns that contract, this just replays it.

  /** Resolved main-model metadata (context length + capabilities). */
  async modelInfo(): Promise<ModelInfo> {
    return this.request("/api/model/info");
  }

  /**
   * Every catalog provider (authenticated or not) with curated model lists
   * and picker hints (`authenticated`/`auth_type`/`key_env`/`warning`) —
   * the same payload the dashboard picker consumes.
   */
  async modelOptions(): Promise<ModelOptionsResponse> {
    return this.request("/api/model/options");
  }

  /** Auxiliary task-slot assignments plus the current main model. */
  async auxiliaryModels(): Promise<AuxiliaryModelsResponse> {
    return this.request("/api/model/auxiliary");
  }

  /**
   * Assign provider+model to the main slot or one auxiliary task.
   * `scope: "auxiliary"` with `provider: "auto"` resets the slot to inherit
   * the main model. `confirm_expensive_model` re-sends after the upstream
   * `confirm_required` response.
   */
  async setModelAssignment(body: {
    scope: "main" | "auxiliary";
    provider: string;
    model: string;
    task?: string;
    base_url?: string;
    api_key?: string;
    confirm_expensive_model?: boolean;
  }): Promise<ModelSetResponse> {
    return this.request("/api/model/set", { method: "POST", json: body });
  }

  /** Per-model usage/cost analytics for the "In use" list. */
  async modelsAnalytics(days = 30): Promise<ModelsAnalyticsResponse> {
    return this.request(`/api/analytics/models?days=${days}`);
  }

  /** Backup models tried in order when the main model fails. */
  async fallbackModels(): Promise<FallbackModelsResponse> {
    return this.request("/api/model/fallback");
  }

  /** Replace a whole backup-model list (order = try order): Main's when
   *  `task` is omitted, otherwise that task role's. */
  async setFallbackModels(
    providers: FallbackModel[],
    task?: string,
  ): Promise<FallbackModelsResponse> {
    return this.request("/api/model/fallback", {
      method: "PUT",
      json: task ? { providers, task } : { providers },
    });
  }

  /** Reload saved provider keys now and clear old "key failed" marks. */
  async refreshProviderKeys(): Promise<RefreshKeysResponse> {
    return this.request("/api/providers/refresh-keys", { method: "POST" });
  }

  /** Per-call latency/failure/token telemetry for the Performance section. */
  async modelsPerformance(
    days = 7,
    months = 6,
  ): Promise<ModelsPerformanceResponse> {
    return this.request(
      `/api/analytics/models/performance?days=${days}&months=${months}`,
    );
  }

  /** Fire one real completion against a slot or ad-hoc provider+model —
   *  proves the config works end-to-end (key, endpoint, model id). */
  async testModel(body: {
    scope: string;
    task?: string;
    provider?: string;
    model?: string;
  }): Promise<ModelTestResponse> {
    return this.request("/api/model/test", { method: "POST", json: body });
  }

  /** Live-probe a provider credential before persisting it. */
  async validateProviderKey(
    key: string,
    value: string,
  ): Promise<ProviderValidateResponse> {
    return this.request("/api/providers/validate", {
      method: "POST",
      json: { key, value },
    });
  }

  /** Write a `.env` value (provider API keys live there). */
  async setEnvVar(key: string, value: string): Promise<{ ok: boolean; key: string }> {
    return this.request("/api/env", { method: "PUT", json: { key, value } });
  }

  /** Remove a `.env` value — disconnects a key-based provider. */
  async deleteEnvVar(key: string): Promise<{ ok: boolean; key: string }> {
    return this.request("/api/env", { method: "DELETE", json: { key } });
  }

  // ── Projects redesign: ask ──

  /** Ask the project a read-only question; answered in its own one-shot session. */
  async askProject(
    slug: string,
    body: { question: string; history?: import("@/types").AskProjectHistoryTurn[] },
    idempotencyKey?: string,
  ): Promise<import("@/types").AskProjectResponse> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/ask`,
      {
        method: "POST",
        json: body,
        headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
      },
    );
  }

  // ── Projects redesign: outputs ──

  /** Every file the project's runs and cards produced, newest first. */
  async projectArtifacts(
    slug: string,
  ): Promise<import("@/types").ProjectArtifact[]> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/artifacts`,
    );
  }

  /**
   * The bytes of one produced file, as the raw upstream `Response` for the
   * BFF to pipe (like `openChatStream`, the body is not consumed here).
   */
  async projectArtifactContent(
    slug: string,
    artifactId: string,
    range?: string | null,
  ): Promise<Response> {
    const headers = new Headers();
    if (this.hermesToken) {
      headers.set("cookie", `hermes_session_at=${this.hermesToken}`);
      headers.set("authorization", `Bearer ${this.hermesToken}`);
    }
    if (range) headers.set("range", range);
    const path = this.scopedPath(
      `/api/registry/projects/${encodeURIComponent(slug)}/artifacts/${encodeURIComponent(artifactId)}/content`,
    );
    const res = await fetch(`${this.baseUrl}${path}`, { headers, cache: "no-store" });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const parsed = text ? safeJson(text) : undefined;
      throw new HermesApiError(
        res.status,
        upstreamDetail(parsed, "That file could not be opened."),
        parsed ?? text,
      );
    }
    return res;
  }

  // ── Projects redesign: live ──

  /**
   * A board-dispatched card's live reasoning and tool names, as SSE for the
   * BFF to pipe (`GET /{slug}/cards/{id}/activity?after=`). Same frames as
   * `openRunActivityStream`; tool arguments and results never cross.
   */
  async openCardActivityStream(
    slug: string,
    taskId: string,
    after: number,
  ): Promise<Response> {
    const headers = new Headers({ accept: "text/event-stream" });
    if (this.hermesToken) {
      headers.set("cookie", `hermes_session_at=${this.hermesToken}`);
      headers.set("authorization", `Bearer ${this.hermesToken}`);
    }
    const res = await fetch(
      `${this.baseUrl}/api/registry/projects/${encodeURIComponent(slug)}/cards/${encodeURIComponent(taskId)}/activity?after=${encodeURIComponent(after)}`,
      { headers, cache: "no-store" },
    );
    if (!res.ok || !res.body) {
      const text = res.body ? await res.text().catch(() => "") : "";
      throw new HermesApiError(
        res.status,
        upstreamDetail(
          text ? safeJson(text) : undefined,
          "That task has no activity to show.",
        ),
        text,
      );
    }
    return res;
  }

  // ── Projects redesign: changes ──
  /** Every directive (retired included) with change metadata, and every run. */
  async projectChanges(slug: string): Promise<import("@/types").ProjectChangesHistory> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/changes`,
    );
  }

  /** Record a requirement change; `now`/`next` also draft the revised plan. */
  async createProjectChange(
    slug: string,
    payload: {
      text: string;
      kinds: import("@/types").ProjectChangeKind[];
      apply: import("@/types").ProjectChangeApply;
    },
    idempotencyKey?: string,
  ): Promise<import("@/types").ProjectChangeResult> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/changes`,
      {
        method: "POST",
        json: payload,
        headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
      },
    );
  }

  /** Draft the revised plan again for a recorded change. */
  async redraftProjectChange(
    slug: string,
    changeId: string,
  ): Promise<{ change: import("@/types").ProjectChange; draft: import("@/types").ProjectChangeDraftState }> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/changes/${encodeURIComponent(changeId)}/draft`,
      { method: "POST", json: {} },
    );
  }

  /** Activate the drafted plan and (unless `start: false`) start the next run. */
  // ── Projects: scope clarification ──

  /** `GET /{slug}/clarify` — rounds, questions and the generation job. */
  async projectClarify(slug: string): Promise<import("@/types").ClarifyState> {
    return this.request(`/api/registry/projects/${encodeURIComponent(slug)}/clarify`);
  }

  /** `POST /{slug}/clarify/questions` — ask the agent for a (next) round.
   * Returns at once with `job.status: "running"`; poll `projectClarify`. */
  async askClarifyQuestions(
    slug: string,
    payload: { focus?: string },
    idempotencyKey?: string,
  ): Promise<import("@/types").ClarifyState> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/clarify/questions`,
      {
        method: "POST",
        json: payload,
        headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
      },
    );
  }

  /** `POST /{slug}/clarify/answers` — `[{id, answer} | {id, skip: true}]`. */
  async answerClarifyQuestions(
    slug: string,
    payload: { answers: import("@/types").ClarifyAnswerInput[] },
    idempotencyKey?: string,
  ): Promise<import("@/types").ClarifyState> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/clarify/answers`,
      {
        method: "POST",
        json: payload,
        headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
      },
    );
  }

  /** `POST /{slug}/clarify/confirm` — confirm the understanding (optionally
   * edited) and, with `draft_plan`, start the plan draft from it. */
  async confirmClarify(
    slug: string,
    payload: { understanding?: string; draft_plan?: boolean },
    idempotencyKey?: string,
  ): Promise<import("@/types").ClarifyConfirmResult> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/clarify/confirm`,
      {
        method: "POST",
        json: payload,
        headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
      },
    );
  }

  async approveProjectChange(
    slug: string,
    changeId: string,
    payload: { rev: number; start?: boolean; supersedes?: string[] },
    idempotencyKey?: string,
  ): Promise<import("@/types").ProjectChangeApproveResult> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/changes/${encodeURIComponent(changeId)}/approve`,
      {
        method: "POST",
        json: payload,
        headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
      },
    );
  }

  // ── Projects redesign: safety ──

  private idempotencyKey?: string;

  /**
   * Forward the browser's `Idempotency-Key` on this client's writes, so a
   * retried click replays upstream instead of acting twice. Never invented
   * here: no key from the browser means no header upstream.
   */
  forwardIdempotencyKey(key: string | null | undefined): this {
    const trimmed = (key ?? "").trim();
    this.idempotencyKey = trimmed || undefined;
    return this;
  }

  private applyIdempotencyKey(headers: Headers, method: string | undefined): void {
    if (!this.idempotencyKey || headers.has("idempotency-key")) return;
    const verb = (method ?? "GET").toUpperCase();
    if (verb === "POST" || verb === "PATCH" || verb === "PUT" || verb === "DELETE") {
      headers.set("Idempotency-Key", this.idempotencyKey);
    }
  }

  // ── Projects redesign: board ──

  /** Which run created each card, and whether the open run is stalled. */
  async projectBoardContext(slug: string): Promise<import("@/types").ProjectBoardContext> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/board/context`,
    );
  }

  /** Approve all N: make several triage cards ready in one judgement act. */
  async approveProjectCards(
    slug: string,
    taskIds: string[],
  ): Promise<import("@/types").ProjectCardsApproveResponse> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/cards/approve`,
      { method: "POST", json: { task_ids: taskIds } },
    );
  }

  /** Blocked → ready, with an optional reason left on the card's thread. */
  async unblockProjectCard(
    slug: string,
    taskId: string,
    reason?: string,
  ): Promise<import("@/types").ProjectCardDetail> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/cards/${encodeURIComponent(taskId)}/unblock`,
      { method: "POST", json: reason ? { reason } : {} },
    );
  }

  /** Answer an approval the card's worker asked for; releases the card once
   * nothing else is pending. */
  async decideProjectCardApproval(
    slug: string,
    taskId: string,
    key: string,
    decision: "approve" | "deny",
  ): Promise<import("@/types").ProjectBoardTask> {
    return this.request(
      `/api/registry/projects/${encodeURIComponent(slug)}/cards/${encodeURIComponent(taskId)}/approvals`,
      { method: "POST", json: { key, decision } },
    );
  }
}

/**
 * `X-Forwarded-For` carrying the invitee's own address, or no header at all.
 *
 * The unauthenticated invitation endpoints throttle per IP, and every one of
 * their requests reaches Python from *this* server — so without this the whole
 * internet shares one bucket. Python only trusts the header from a loopback
 * peer, which this call is.
 */
function forwardedFor(clientIp: string): Record<string, string> {
  return clientIp ? { "X-Forwarded-For": clientIp } : {};
}

/** `GET /api/sessions/{id}/active_run`: the live turn and its undelivered inputs. */
export interface ActiveChatRun {
  run_id: string | null;
  pending?: Array<{
    item_id: string;
    mode: ChatInputMode;
    text: string;
    created_at?: number | string | null;
  }>;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export interface SetupModelResult {
  ok: boolean;
  provider?: string;
  model?: string;
  latency_ms?: number;
  error?: "key_rejected" | "no_model" | "test_failed";
  detail?: string;
}

export interface SetupDomainResult {
  ok: boolean;
  host: string;
  resolves: boolean;
  points_here: boolean;
  https_ready: boolean;
  server_addresses: string[];
}
