"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { ActivityItem, ActivityRunning } from "@/types";

export const ACTIVITY_POLL_MS = 15_000;
const CLOCK_TICK_MS = 1_000;
/** A run older than this turns amber — worth a look. */
export const LONG_RUN_MS = 30 * 60_000;

export const ACTIVITY_GLYPH: Record<ActivityItem["kind"], string> = {
  chat: "❝",
  project_run: "▶",
  card: "▣",
  cron: "◷",
};

export const ACTIVITY_KIND_LABEL: Record<ActivityItem["kind"], string> = {
  chat: "Chat",
  project_run: "Project run",
  card: "Card",
  cron: "Scheduled job",
};

/** Compact elapsed time: "42s", "12m", "1h 05m", "2d 3h". */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Elapsed ms for a row (null when it has no start time) and its long-run flag. */
export function activityTiming(
  item: ActivityItem,
  now: number,
): { elapsedMs: number | null; long: boolean } {
  const elapsedMs = item.started_at !== null ? now - item.started_at * 1000 : null;
  return { elapsedMs, long: elapsedMs !== null && elapsedMs >= LONG_RUN_MS };
}

/** Hover/aria label: "Chat: Plan the launch (writer) — waiting". */
export function activityLabel(item: ActivityItem): string {
  return `${ACTIVITY_KIND_LABEL[item.kind] ?? item.kind}: ${item.name}${
    item.profile ? ` (${item.profile})` : ""
  }${item.status === "waiting" ? " — waiting" : ""}`;
}

// Last good read, shared across mounts and consumers (ActivityStrip, the
// landing top bar). A read younger than the poll interval is reused instead
// of re-fetching.
let lastGood: { items: ActivityItem[]; at: number } | null = null;

export function resetActivityRunningCache(): void {
  lastGood = null;
}

export interface ActivityRunningState {
  items: ActivityItem[];
  /** The latest read failed; `items` are the last good rows. */
  stale: boolean;
  /** Local clock, ticking every second while something runs. */
  now: number;
}

/**
 * `GET /api/activity/running` polled every 15 s while the tab is visible and
 * re-read on focus; a failed read keeps the last good rows and flags `stale`.
 * Elapsed timers tick locally (no refetch) only while there is something to
 * time and the tab is visible.
 */
export function useActivityRunning(): ActivityRunningState {
  const [items, setItems] = useState<ActivityItem[]>(() => lastGood?.items ?? []);
  const [stale, setStale] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const mounted = useRef(true);
  // One read at a time: the poll and focus wake share it.
  const inFlight = useRef<Promise<void> | null>(null);

  const tick = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    const run = (async () => {
      try {
        const res = await fetch("/api/activity/running", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as ActivityRunning;
        const next = Array.isArray(data.items) ? data.items : [];
        lastGood = { items: next, at: Date.now() };
        if (mounted.current) {
          setItems(next);
          setNow(Date.now());
          setStale(false);
        }
      } catch {
        if (mounted.current) setStale(true);
      } finally {
        inFlight.current = null;
      }
    })();
    inFlight.current = run;
    return run;
  }, []);

  useEffect(() => {
    mounted.current = true;
    if (!lastGood || Date.now() - lastGood.at >= ACTIVITY_POLL_MS) void tick();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") void tick();
    }, ACTIVITY_POLL_MS);
    const wake = () => {
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    return () => {
      mounted.current = false;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
    };
  }, [tick]);

  const hasItems = items.length > 0;

  useEffect(() => {
    if (!hasItems) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") setNow(Date.now());
    }, CLOCK_TICK_MS);
    return () => clearInterval(t);
  }, [hasItems]);

  return { items, stale, now };
}
