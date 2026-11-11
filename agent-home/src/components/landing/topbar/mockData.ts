import type { StatusSummaryState } from "@/components/ui/useStatusSummary";
import type { ActivityRunningState } from "@/components/ui/useActivityRunning";
import type { ActivityItem, ScheduledSummary, StatusSummary } from "@/types";
import type { NeedsYouEntry } from "@/types/landing";

/** Realistic fixtures for the top bar's tests and screenshot harness. */
export const MOCK_NOW = 1_794_100_000_000;

export const MOCK_SUMMARY: StatusSummary = {
  cpu_pct: 23,
  mem_pct: 48,
  disk_pct: 41,
  tokens_month: { input: 3_100_000, output: 1_100_000, cost_usd: 18.4 },
  active_conversations: 2,
  running_cards: 2,
  cron_total: 5,
  cron_enabled: 3,
  build: "abc1234",
  upload_storage: {
    path: "/data/uploads",
    free_bytes: 120 * 1024 ** 3,
    total_bytes: 500 * 1024 ** 3,
    min_free_bytes: 5 * 1024 ** 3,
    low: false,
  },
  collected_at: MOCK_NOW / 1000,
};

export const MOCK_ACTIVITY: ActivityItem[] = [
  { kind: "chat", id: "s1", name: "Plan the Q3 launch", started_at: MOCK_NOW / 1000 - 4 * 60, href: "/chat?session=s1", profile: null, status: "running" },
  { kind: "project_run", id: "r12", name: "website-redesign · run 12", started_at: MOCK_NOW / 1000 - 41 * 60, href: "/projects/website-redesign", profile: null, status: "running" },
  { kind: "card", id: "c7", name: "Draft onboarding email", started_at: MOCK_NOW / 1000 - 9 * 60, href: "/projects/marketing", profile: "writer", status: "waiting" },
  { kind: "cron", id: "j1", name: "Nightly digest", started_at: MOCK_NOW / 1000 - 60, href: "/cron", profile: null, status: "running" },
];

export function mockEntry(over: Partial<NeedsYouEntry> = {}): NeedsYouEntry {
  return {
    id: "approval:a1",
    source: "card_approval",
    severity: "approval",
    title: "Approve the deploy of website-redesign",
    detail: "website-redesign · run 12",
    context: { project_slug: "website-redesign", run_no: 12 },
    created_at: MOCK_NOW / 1000 - 12 * 60,
    href: "/projects/website-redesign?run=12",
    actions: [
      { id: "approve", label: "Approve", style: "primary", method: "POST", endpoint: "/api/approvals/a1" },
      { id: "open", label: "Review", style: "secondary", href: "/projects/website-redesign?run=12" },
    ],
    reversible: false,
    ...over,
  };
}

export const MOCK_NEEDS_YOU: NeedsYouEntry[] = [
  mockEntry({
    id: "question:q1",
    source: "clarify",
    severity: "blocking",
    title: "Which pricing tier should the landing page highlight?",
    detail: "Plan the Q3 launch",
    context: { session_id: "s1" },
    created_at: MOCK_NOW / 1000 - 3 * 60,
    href: "/chat?session=s1",
    actions: [{ id: "answer", label: "Answer", style: "primary", href: "/chat?session=s1" }],
  }),
  mockEntry(),
  mockEntry({
    id: "review:r1",
    source: "output_acceptance",
    severity: "review",
    title: "Review the onboarding email draft",
    detail: "marketing",
    created_at: MOCK_NOW / 1000 - 60 * 60,
    href: "/projects/marketing",
    actions: [],
  }),
];

export function mockStatus(over: Partial<StatusSummaryState> = {}): StatusSummaryState {
  return {
    summary: MOCK_SUMMARY,
    stale: false,
    fetchedAt: MOCK_NOW - 12_000,
    now: MOCK_NOW,
    refreshing: false,
    refresh: async () => {},
    ...over,
  };
}

export const MOCK_SCHEDULED: ScheduledSummary = {
  total: 6,
  projects: 3,
  cards: 2,
  cron_jobs: 1,
  next_run_at: MOCK_NOW / 1000 + 2 * 3600,
};

export function mockActivity(over: Partial<ActivityRunningState> = {}): ActivityRunningState {
  return { items: MOCK_ACTIVITY, scheduled: null, loaded: true, stale: false, now: MOCK_NOW, ...over };
}
