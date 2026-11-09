import type { SessionSummary } from "@/types";

/**
 * A row of `GET /api/chat/sessions` as the landing sidebar reads it. The
 * Python list already stamps `profile`; `pinned_at` arrives with the pins
 * workstream (B2) — absent on every row means pins are not deployed yet.
 */
export type LandingSession = SessionSummary & {
  pinned_at?: number | null;
  profile?: string;
};

/** Pins are live once the list carries a `pinned_at` key (null or a time). */
export function pinsSupported(sessions: LandingSession[]): boolean {
  return sessions.some((s) => Object.prototype.hasOwnProperty.call(s, "pinned_at"));
}

export function isPinned(s: LandingSession): boolean {
  return typeof s.pinned_at === "number" && s.pinned_at > 0;
}

function lastActive(s: LandingSession): number {
  return s.last_active ?? s.started_at ?? 0;
}

/** Pinned (most recently pinned first) and Recent (newest first). */
export function splitSessions(sessions: LandingSession[]): {
  pinned: LandingSession[];
  recent: LandingSession[];
} {
  const visible = sessions.filter((s) => !s.archived);
  const pinned = visible
    .filter(isPinned)
    .sort((a, b) => (b.pinned_at ?? 0) - (a.pinned_at ?? 0));
  const recent = visible
    .filter((s) => !isPinned(s))
    .sort((a, b) => lastActive(b) - lastActive(a));
  return { pinned, recent };
}

export function matchesQuery(s: LandingSession, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [s.title, s.preview, ...(s.tags ?? []).map((t) => t.name)]
    .filter((v): v is string => typeof v === "string")
    .some((v) => v.toLowerCase().includes(q));
}

/** "just now", "14 min ago", "3 h ago", "yesterday", "Mon", "12 Oct". */
export function relativeTime(epochSeconds: number | null | undefined, now = Date.now()): string {
  if (!epochSeconds) return "";
  const ms = epochSeconds * 1000;
  const diff = Math.max(0, now - ms);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} h ago`;
  const then = new Date(ms);
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const days = Math.ceil((startOfToday - ms) / 86_400_000);
  if (days <= 1) return "yesterday";
  if (days < 7) return then.toLocaleDateString("en", { weekday: "short" });
  return then.toLocaleDateString("en", { day: "numeric", month: "short" });
}

/** Second line of a row: "<tag or profile> · <when>", or "working now". */
export function sessionMeta(s: LandingSession, profileLabel: string, now = Date.now()): string {
  const who = s.tags?.[0]?.name ?? s.profile ?? profileLabel;
  const label = who === "default" ? "Default" : who;
  const when = s.is_active ? "working now" : relativeTime(s.last_active ?? s.started_at, now);
  return when ? `${label} · ${when}` : label;
}

/** Who the chat belongs to, plus "working now" while the agent is replying. */
export function sessionOwner(s: LandingSession, profileLabel: string): string {
  const who = s.tags?.[0]?.name ?? s.profile ?? profileLabel;
  const label = who === "default" ? "Default" : who;
  return s.is_active ? `${label} · working now` : label;
}

/** When the chat last changed: a short relative label plus the full date for tooltips. */
export function lastUpdated(
  s: LandingSession,
  now = Date.now(),
): { label: string; iso: string; full: string } | null {
  const at = s.last_active ?? s.started_at;
  if (!at) return null;
  const date = new Date(at * 1000);
  return {
    label: relativeTime(at, now),
    iso: date.toISOString(),
    full: date.toLocaleString("en", { dateStyle: "medium", timeStyle: "short" }),
  };
}

/** “A” and “B” / “A”, “B” and “C” — names the chats a suggestion covers. */
export function quoteList(names: string[]): string {
  const quoted = names.map((n) => `“${n}”`);
  if (quoted.length <= 1) return quoted.join("");
  return `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
}

export function displayTitle(s: Pick<LandingSession, "title" | "preview">): {
  text: string;
  untitled: boolean;
} {
  const title = s.title?.trim();
  if (title) return { text: title, untitled: false };
  const preview = s.preview?.trim();
  return { text: preview || "New chat", untitled: true };
}
