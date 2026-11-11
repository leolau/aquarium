/**
 * Shapes and helpers for the Skills Lab Improve tab: improve chats (C-3), the
 * version list a draft is saved into (C-2) and the run evidence (C-1).
 */

export type SkillOutcome = "success" | "partial" | "failure" | null;

export interface SkillVersionMeta {
  id: string;
  n: number;
  created_at: number | string | null;
  author: string;
  message: string;
  parent: string | null;
  status: "active" | "draft" | "archived";
  source: string;
  sha256?: string;
  trial_of: string | null;
}

export interface SkillVersionList {
  name: string;
  active: string | null;
  versions: SkillVersionMeta[];
}

export interface SkillUsageEvent {
  id: number;
  ts: number;
  trigger: string;
  version_id: string | null;
  outcome: SkillOutcome;
  outcome_source: string | null;
  rating: -1 | 0 | 1 | null;
  note: string | null;
  session: { id: string; title: string | null } | null;
  task: { id: string; title: string | null } | null;
  project: { slug: string; name: string | null } | null;
  user_id: string | null;
}

export interface SkillUsageDetail {
  name: string;
  events: SkillUsageEvent[];
  next_cursor: string | null;
}

export interface ImproveSession {
  session_id: string;
  title: string | null;
  started_at: number | string | null;
  drafts: number;
}

export interface ImproveReply {
  reply: string;
  draft?: string | null;
}

/** A project slug or short ref, as the projects API accepts it. */
export const PROJECT_SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const DRAFT_RE = /```skill-draft[^\n]*\n([\s\S]*?)\n?```/g;

/** The SKILL.md inside the last ```skill-draft block of an agent reply, if any. */
export function extractDraft(text: string): string | null {
  let last: string | null = null;
  for (const m of text.matchAll(DRAFT_RE)) last = m[1];
  return last;
}

/** The reply with its ```skill-draft blocks removed (the draft renders as its own card). */
export function stripDraft(text: string): string {
  return text.replace(DRAFT_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** The `n` the next saved version gets. */
export function nextVersionNumber(versions: SkillVersionMeta[]): number {
  return versions.reduce((max, v) => Math.max(max, Number(v.n) || 0), 0) + 1;
}

export function versionLabel(list: SkillVersionList | null, id: string | null): string {
  if (!id) return "";
  const v = list?.versions.find((x) => x.id === id);
  return v ? `v${v.n}` : id;
}

export type EvidenceFilter = "failed" | "unhelpful" | "all";

export function matchesEvidence(event: SkillUsageEvent, filter: EvidenceFilter): boolean {
  if (filter === "failed") return event.outcome === "failure";
  if (filter === "unhelpful") return event.rating === -1;
  return true;
}

/** What the run was: a kanban task, a project run or a chat. */
export function evidenceTitle(event: SkillUsageEvent): { kind: string; title: string } {
  if (event.task) return { kind: "Task", title: event.task.title || event.task.id };
  if (event.project) return { kind: "Project", title: event.project.name || event.project.slug };
  if (event.session) return { kind: "Chat", title: event.session.title ? `“${event.session.title}”` : event.session.id };
  return { kind: "Run", title: `#${event.id}` };
}

export function evidenceStatus(event: SkillUsageEvent): { label: string; tone: "danger" | "warn" | "success" | "muted" } {
  if (event.outcome === "failure") return { label: "Failed", tone: "danger" };
  if (event.rating === -1) return { label: "Not helpful", tone: "danger" };
  if (event.outcome === "partial") return { label: "Partial", tone: "warn" };
  if (event.outcome === "success") return { label: "Succeeded", tone: "success" };
  if (event.rating === 1) return { label: "Helpful", tone: "success" };
  return { label: "Not rated", tone: "muted" };
}

/** The line a selected run adds to the composer, so the agent can find it in the evidence. */
export function evidenceReference(event: SkillUsageEvent, versions: SkillVersionList | null): string {
  const { kind, title } = evidenceTitle(event);
  const parts = [`run #${event.id}`, `${kind} ${title}`, evidenceStatus(event).label.toLowerCase()];
  const v = versionLabel(versions, event.version_id);
  if (v) parts.push(v);
  if (event.note) parts.push(`note: “${event.note}”`);
  return `[${parts.join(" · ")}]`;
}

/** A Unix-seconds or ISO timestamp as a short local date. */
export function shortDate(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
