/**
 * Response shaping for the skill usage BFF routes: only the documented fields
 * reach the browser, with types coerced so the UI can trust them.
 */
import type { SkillUsageEvent, SkillUsageList, SkillUsageRow } from "@/lib/skills/usage";

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const rec = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Days the window may cover; anything else falls back to 90. */
export function usageDays(raw: string | null): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 365 ? n : 90;
}

export function usageLimit(raw: string | null): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 200 ? n : 50;
}

export function toUsageRow(raw: unknown): SkillUsageRow {
  const r = rec(raw) ?? {};
  return {
    name: typeof r.name === "string" ? r.name : "",
    uses: num(r.uses),
    sessions: num(r.sessions),
    tasks: num(r.tasks),
    projects: num(r.projects),
    success: num(r.success),
    partial: num(r.partial),
    failure: num(r.failure),
    unknown: num(r.unknown),
    success_rate: numOrNull(r.success_rate),
    last_used_at: numOrNull(r.last_used_at),
    trend: list(r.trend)
      .map(rec)
      .filter((t): t is Record<string, unknown> => t !== null && typeof t.day === "string")
      .map((t) => ({ day: t.day as string, uses: num(t.uses) })),
  };
}

export function toUsageList(raw: unknown): SkillUsageList {
  const r = rec(raw) ?? {};
  return { days: num(r.days) || 90, skills: list(r.skills).map(toUsageRow).filter((s) => s.name) };
}

const OUTCOMES = new Set(["success", "partial", "failure"]);
const SOURCES = new Set(["kanban", "user", "auto"]);

export function toUsageEvent(raw: unknown): SkillUsageEvent {
  const r = rec(raw) ?? {};
  const session = rec(r.session);
  const task = rec(r.task);
  const project = rec(r.project);
  const rating = r.rating === -1 || r.rating === 0 || r.rating === 1 ? r.rating : null;
  return {
    id: num(r.id),
    ts: num(r.ts),
    trigger: typeof r.trigger === "string" ? r.trigger : "",
    version_id: strOrNull(r.version_id),
    outcome: OUTCOMES.has(r.outcome as string) ? (r.outcome as SkillUsageEvent["outcome"]) : null,
    outcome_source: SOURCES.has(r.outcome_source as string) ? (r.outcome_source as SkillUsageEvent["outcome_source"]) : null,
    rating,
    note: strOrNull(r.note),
    session: session && strOrNull(session.id) ? { id: session.id as string, title: strOrNull(session.title) } : null,
    task: task && strOrNull(task.id) ? { id: task.id as string, title: strOrNull(task.title) } : null,
    project: project && strOrNull(project.slug) ? { slug: project.slug as string, name: strOrNull(project.name) } : null,
    user_id: strOrNull(r.user_id),
  };
}
