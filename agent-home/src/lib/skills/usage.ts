/**
 * Skill usage ledger shapes (`GET /api/skills/usage`, `/usage/detail`,
 * `POST /usage/feedback`) and the pure helpers the Usage tab and the skills
 * list share.
 */

export type UsageOutcome = "success" | "partial" | "failure";
export type UsageTrigger = "skill_view" | "slash" | "preload" | "cron" | "bundle";

export interface SkillUsageRow {
  name: string;
  uses: number;
  sessions: number;
  tasks: number;
  projects: number;
  success: number;
  partial: number;
  failure: number;
  unknown: number;
  /** success ÷ (success + partial + failure), 0-1; null when nothing has a result. */
  success_rate: number | null;
  /** Epoch seconds. */
  last_used_at: number | null;
  trend: Array<{ day: string; uses: number }>;
}

export interface SkillUsageList {
  days: number;
  skills: SkillUsageRow[];
}

export interface SkillUsageEvent {
  id: number;
  ts: number;
  trigger: UsageTrigger | string;
  version_id: string | null;
  outcome: UsageOutcome | null;
  outcome_source: "kanban" | "user" | "auto" | null;
  rating: -1 | 0 | 1 | null;
  note: string | null;
  session: { id: string; title: string | null } | null;
  task: { id: string; title: string | null } | null;
  project: { slug: string; name: string | null } | null;
  user_id: string | null;
}

export interface SkillUsageDetail {
  name: string;
  summary: SkillUsageRow;
  by_version: Array<{ version_id: string | null; uses: number; success_rate: number | null }>;
  events: SkillUsageEvent[];
  next_cursor: string | null;
}

export const USAGE_WINDOWS = [30, 90] as const;
export type UsageWindow = (typeof USAGE_WINDOWS)[number];

export function parseWindow(value: string | null | undefined): UsageWindow {
  return value === "30" ? 30 : 90;
}

/** "82%", or null when there is no rated / kanban result yet. */
export function percent(rate: number | null | undefined): string | null {
  return typeof rate === "number" && Number.isFinite(rate) ? `${Math.round(rate * 100)}%` : null;
}

export type UsageKind = "chat" | "task" | "project";

/** A run in a kanban task is a task; a project-level run a project; anything else a chat. */
export function eventKind(e: SkillUsageEvent): UsageKind {
  if (e.task) return "task";
  if (e.project) return "project";
  return "chat";
}

export type UsageFilter = "all" | "chats" | "tasks" | "projects" | "failed" | "unrated";

export function matchesFilter(e: SkillUsageEvent, f: UsageFilter): boolean {
  switch (f) {
    case "chats":
      return eventKind(e) === "chat";
    case "tasks":
      return e.task !== null;
    case "projects":
      return e.project !== null;
    case "failed":
      return e.outcome === "failure";
    case "unrated":
      return e.outcome === null;
    default:
      return true;
  }
}

/** Only chat runs with no result yet are rated by hand; kanban runs report their own. */
export function canRate(e: SkillUsageEvent): boolean {
  return eventKind(e) === "chat" && e.outcome === null && e.rating === null;
}

/** Add one hand rating to the summary counts (the run had no result before). */
export function applyRating(summary: SkillUsageRow, before: SkillUsageEvent, after: SkillUsageEvent): SkillUsageRow {
  if (before.outcome === after.outcome) return summary;
  const next = { ...summary };
  const bump = (o: UsageOutcome | null, by: number) => {
    if (o === null) next.unknown = Math.max(0, next.unknown + by);
    else next[o] = Math.max(0, next[o] + by);
  };
  bump(before.outcome, -1);
  bump(after.outcome, 1);
  const rated = next.success + next.partial + next.failure;
  next.success_rate = rated ? next.success / rated : null;
  return next;
}

/** Consecutive UTC days ending today (or the last reported day), uses filled with 0. */
export function fillTrend(trend: SkillUsageRow["trend"], days: number, now = Date.now()): Array<{ day: string; uses: number }> {
  const byDay = new Map(trend.map((t) => [t.day, t.uses]));
  const last = trend.reduce((m, t) => (t.day > m ? t.day : m), new Date(now).toISOString().slice(0, 10));
  const end = Date.parse(`${last}T00:00:00Z`);
  const out: Array<{ day: string; uses: number }> = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = new Date(end - i * 86_400_000).toISOString().slice(0, 10);
    out.push({ day, uses: byDay.get(day) ?? 0 });
  }
  return out;
}

export function versionLabel(id: string | null): string {
  return id ?? "unversioned";
}
