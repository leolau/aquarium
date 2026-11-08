"use client";

import type { ActivityItem, ActivityRunning } from "@/types";

import { type PolledCache, usePolled } from "./usePolled";

/**
 * The same feed `ActivityStrip` reads (`GET /api/activity/running`): chats,
 * project runs, kanban cards and cron jobs running or waiting right now.
 * 15 s poll while visible, re-read on focus, last good rows on failure.
 */
const cache: { current: PolledCache<ActivityItem[]> | null } = { current: null };

export function resetRunningActivityCache(): void {
  cache.current = null;
}

async function readRunning(): Promise<ActivityItem[] | null> {
  try {
    const res = await fetch("/api/activity/running", { cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as ActivityRunning;
    return Array.isArray(data.items) ? data.items : [];
  } catch {
    return null;
  }
}

export function useRunningActivity(): {
  items: ActivityItem[];
  loaded: boolean;
  stale: boolean;
  refresh: () => Promise<void>;
} {
  const { value, stale, loaded, refresh } = usePolled(readRunning, cache);
  return { items: value ?? [], loaded, stale, refresh };
}
