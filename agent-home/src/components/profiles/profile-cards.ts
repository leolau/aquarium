import {
  CREATURES,
  CREATURE_IDS,
  isCreatureId,
  type CreatureId,
} from "@/lib/aquarium/creatures";
import { parseRef } from "@/lib/refs";
import { timeAgo } from "@/lib/skills/versions";
import type { ProfileInfo, ProfileStats } from "@/types";

/** Card status, in the order the filter tabs list them. */
export type ProfileStatus = "working" | "ready" | "off" | "setup";
export type StatusFilter = "all" | ProfileStatus;
export type ProfileSort = "active" | "name" | "tokens";

export const STATUS_LABEL: Record<ProfileStatus, string> = {
  working: "Working now",
  ready: "Ready",
  off: "Gateway off",
  setup: "Needs setup",
};

export const FILTER_LABEL: Record<StatusFilter, string> = {
  all: "All",
  working: "Working",
  ready: "Ready",
  off: "Off",
  setup: "Needs setup",
};

export const SORT_LABEL: Record<ProfileSort, string> = {
  active: "Most active",
  name: "Name",
  tokens: "Tokens",
};

export function profileStatus(
  p: ProfileInfo,
  stats: ProfileStats | undefined,
): ProfileStatus {
  if (!p.model) return "setup";
  if (stats?.current_task) return "working";
  return p.gateway_running ? "ready" : "off";
}

/** The profile's saved creature; a stable pick from its name when the server sent none. */
export function profileCreature(p: ProfileInfo): CreatureId {
  if (isCreatureId(p.creature)) return p.creature;
  let h = 0;
  for (const ch of p.name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return CREATURE_IDS[h % CREATURE_IDS.length];
}

export function creatureLabel(id: CreatureId): string {
  return CREATURES.find((c) => c.id === id)?.label ?? id;
}

/** 1234 → "1.2k", 1_200_000 → "1.2M". */
export function compactNumber(n: number): string {
  if (n < 1000) return String(n);
  const [div, unit] =
    n >= 1e9 ? [1e9, "B"] : n >= 1e6 ? [1e6, "M"] : [1e3, "k"];
  const v = n / div;
  return `${v >= 100 ? Math.round(v) : Number(v.toFixed(1))}${unit}`;
}

export function costLabel(usd: number): string {
  if (usd <= 0) return "no cost recorded";
  return `≈ $${usd < 100 ? usd.toFixed(2) : Math.round(usd)}`;
}

/** "Now: …" when working, else "Last active …" or "Never used". */
export function activityLine(
  stats: ProfileStats | undefined,
  now = Date.now(),
): string {
  const task = stats?.current_task;
  if (task) {
    if (task.title) return `Now: ${task.title}`;
    if (task.kind === "task") return "Now: working on a private task";
    if (task.kind === "project") return "Now: running a project";
    return "Now: in a chat";
  }
  if (!stats?.last_active_at) return "Never used";
  return `Last active ${timeAgo(stats.last_active_at, now)}`;
}

/** Short "last active" for phone rows: "working", "3h ago", "never". */
export function activityShort(
  stats: ProfileStats | undefined,
  now = Date.now(),
): string {
  if (stats?.current_task) return "working";
  if (!stats?.last_active_at) return "never";
  return timeAgo(stats.last_active_at, now);
}

const CHANNEL_LABEL: Record<string, string> = {
  web: "Web",
  "agent-home": "Web",
  api_server: "Web",
  cli: "CLI",
  tui: "CLI",
  cron: "Scheduled",
};

function channelLabel(id: string): string {
  return CHANNEL_LABEL[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

/** Connected gateway platforms plus where its chats came from, deduplicated. */
export function channelLabels(stats: ProfileStats | undefined): string[] {
  if (!stats) return [];
  return [
    ...new Set([...stats.chat_sources, ...stats.channels].map(channelLabel)),
  ];
}

export function matchesSearch(
  p: ProfileInfo,
  stats: ProfileStats | undefined,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  // A profile ref (`A3`) is an exact handle: `a1` must not match A10–A19.
  const ref = parseRef(q);
  if (ref?.kind === "A") return p.ref === ref.ref;
  const hay = [
    p.name,
    p.description,
    creatureLabel(profileCreature(p)),
    ...(stats?.top_skills ?? []).map((s) => s.name),
  ];
  return hay.some((h) => h.toLowerCase().includes(q));
}

export function sortProfiles(
  list: ProfileInfo[],
  stats: Record<string, ProfileStats> | null,
  sort: ProfileSort,
): ProfileInfo[] {
  const s = (p: ProfileInfo) => stats?.[p.name];
  const byName = (a: ProfileInfo, b: ProfileInfo) =>
    Number(b.is_default) - Number(a.is_default) || a.name.localeCompare(b.name);
  const out = [...list];
  if (sort === "name") return out.sort((a, b) => a.name.localeCompare(b.name));
  if (sort === "tokens")
    return out.sort(
      (a, b) => (s(b)?.tokens ?? 0) - (s(a)?.tokens ?? 0) || byName(a, b),
    );
  return out.sort(
    (a, b) =>
      Number(Boolean(s(b)?.current_task)) -
        Number(Boolean(s(a)?.current_task)) ||
      (s(b)?.last_active_at ?? 0) - (s(a)?.last_active_at ?? 0) ||
      byName(a, b),
  );
}
