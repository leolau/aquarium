import type { SessionSummary, SessionTag } from "@/types";

export type ChatCategory = "kanban" | "daily" | "scheduled" | "others";

export const CHAT_CATEGORY_LABELS: Record<ChatCategory, string> = {
  kanban: "Kanban",
  daily: "Daily",
  scheduled: "Scheduled",
  others: "Others",
};

/** Display order for category sections. */
export const CHAT_CATEGORY_ORDER: ChatCategory[] = [
  "kanban",
  "daily",
  "scheduled",
  "others",
];

/**
 * A manual category override is stored as an ordinary session tag, named
 * with this reserved prefix (e.g. `category:kanban`) — reusing the
 * existing tag system (`session_tags`/`session_tag_map`) instead of a new
 * column, per this repo's "extend existing code before adding schema"
 * convention. These tags are deliberately hidden from the generic Tags UI
 * (`SessionModal`) so they don't show up as regular user tags — they're
 * surfaced only through the dedicated Category field.
 */
const CATEGORY_TAG_PREFIX = "category:";

export function categoryOverrideTagName(category: ChatCategory): string {
  return `${CATEGORY_TAG_PREFIX}${category}`;
}

/** True for a tag that exists only to record a category override, never
 * meant to be shown/managed as a regular user-visible tag. */
export function isCategoryOverrideTag(tag: Pick<SessionTag, "name">): boolean {
  return tag.name.toLowerCase().startsWith(CATEGORY_TAG_PREFIX);
}

/** The category a session's tags explicitly override to, if any. Reads the
 * *first* matching override tag — a session should never carry more than
 * one, since setting a new override removes the previous one (see
 * `ChatPane`'s `setSessionCategory`), but this stays well-defined even if
 * that invariant is ever violated by a direct API call. */
export function categoryOverride(
  tags: SessionTag[] | undefined | null,
): ChatCategory | null {
  if (!tags) return null;
  for (const tag of tags) {
    const name = tag.name.toLowerCase();
    if (!name.startsWith(CATEGORY_TAG_PREFIX)) continue;
    const value = name.slice(CATEGORY_TAG_PREFIX.length);
    if (CHAT_CATEGORY_ORDER.includes(value as ChatCategory)) {
      return value as ChatCategory;
    }
  }
  return null;
}

/**
 * Best-effort detector for a kanban card worker's session: its `cwd` sits
 * under a kanban scratch-workspace root. Covers the default board
 * (`.../kanban/workspaces/<task_id>`) and named boards
 * (`.../kanban/boards/<slug>/workspaces/<task_id>`) — see
 * `kanban_db.workspaces_root()`. Does not attempt to catch project-linked
 * *worktree* kanban tasks (`.../.worktrees/<task_id>`), since that path
 * shape is shared with ordinary git worktrees unrelated to kanban at all —
 * a false positive there is worse than a false negative here.
 */
export function isKanbanWorkspace(cwd: string | null | undefined): boolean {
  if (!cwd) return false;
  return cwd.includes("/kanban/workspaces/") || cwd.includes("/kanban/boards/");
}

function isSameLocalDay(epochSeconds: number | null, now: Date): boolean {
  if (epochSeconds === null || !Number.isFinite(epochSeconds)) return false;
  const d = new Date(epochSeconds * 1000);
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

/**
 * Classify a session into one of four display categories.
 *
 * A manual category override (see `categoryOverride`) always wins — the
 * whole point of letting a user move a conversation to a different
 * category is that it stops being auto-derived. Absent an override, the
 * priority order is: a kanban-worker session is "kanban" even if it also
 * happened today; a cron-triggered session is "scheduled" even if today;
 * anything else from today is "daily"; everything older falls to "others".
 */
export function categorizeSession(
  session: Pick<SessionSummary, "source" | "cwd" | "started_at" | "tags">,
  now: Date = new Date(),
): ChatCategory {
  const override = categoryOverride(session.tags);
  if (override) return override;
  if (isKanbanWorkspace(session.cwd)) return "kanban";
  if (session.source === "cron") return "scheduled";
  if (isSameLocalDay(session.started_at, now)) return "daily";
  return "others";
}

/** Group a session list into the four categories, preserving each
 * category's relative order from the input array. */
export function groupSessionsByCategory(
  sessions: SessionSummary[],
  now: Date = new Date(),
): Record<ChatCategory, SessionSummary[]> {
  const groups: Record<ChatCategory, SessionSummary[]> = {
    kanban: [],
    daily: [],
    scheduled: [],
    others: [],
  };
  for (const s of sessions) {
    groups[categorizeSession(s, now)].push(s);
  }
  return groups;
}
