/**
 * Contract for the landing redesign (docs/design/landing-redesign).
 * BFF routes are owned by the backend workstreams; UI workstreams consume
 * these shapes through `src/lib/landing/api.ts` and must tolerate 404/502
 * (route not deployed yet, upstream down) by keeping the last good data.
 */

export type NeedsYouSeverity = "blocking" | "approval" | "review" | "fyi";

export type NeedsYouSource =
  | "project_checkpoint"
  | "budget"
  | "card_wait"
  | "card_approval"
  | "card_blocked"
  | "output_acceptance"
  | "clarify"
  | "plan_approval"
  | "chat_tool_approval"
  | "webview_approval"
  | "todo"
  | "profile_suggestion"
  | "pin_suggestion";

export interface NeedsYouAction {
  id: string;
  label: string;
  style: "primary" | "secondary" | "danger";
  /** One-tap action: POST to an existing BFF route. */
  method?: "POST";
  endpoint?: string;
  body?: Record<string, unknown>;
  /** Navigation action. */
  href?: string;
}

export interface NeedsYouEntry {
  id: string;
  source: NeedsYouSource;
  severity: NeedsYouSeverity;
  title: string;
  detail?: string | null;
  context: {
    project_slug?: string | null;
    run_no?: number | null;
    task_id?: string | null;
    session_id?: string | null;
    run_id?: string | null;
    profile?: string | null;
  };
  created_at: number;
  href: string;
  actions: NeedsYouAction[];
  /** false → the landing page only offers "open", never a one-tap action. */
  reversible?: boolean;
  notification_id?: string | null;
}

export interface NeedsYouResponse {
  items: NeedsYouEntry[];
  count: number;
  by_severity: Record<NeedsYouSeverity, number>;
  collected_at: number;
}

/** GET /api/landing/bar — one poll for the top bar. */
export interface LandingBarResponse {
  health: {
    verdict: "ok" | "degraded" | "down";
    cpu_pct: number | null;
    mem_pct: number | null;
    disk_pct: number | null;
    build_mismatch: boolean;
    low_storage: boolean;
  };
  usage: { tokens_month: number | null };
  work: { running: number; waiting: number; cron_enabled: number };
  needs_you: { count: number; blocking: number };
  collected_at: number;
}

/** POST /api/chat/sessions/pin  { sessionId, pinned } */
export interface PinRequest {
  sessionId: string;
  pinned: boolean;
  profile?: string;
}

export interface PinResponse {
  session_id: string;
  pinned_at: number | null;
}

export interface PinSuggestion {
  session_id: string;
  title: string | null;
  /** Short human reason, e.g. "Unfinished: waiting on your answer". */
  reason: string;
  last_active: number | null;
}

/** GET /api/chat/pin-suggestions?profile= */
export interface PinSuggestionsResponse {
  items: PinSuggestion[];
  generated_at: number | null;
}

/** POST /api/chat/pin-suggestions/dismiss { sessionIds } */
export interface DismissPinSuggestionsRequest {
  sessionIds: string[];
  profile?: string;
}
