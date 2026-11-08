"use client";

/**
 * `useNeedsYou()` — the caller's "Needs you" list, kept live.
 *
 * Polls `GET /api/needs-you` every 15s while the tab is visible, refetches
 * on focus / becoming visible / a service-worker `needs-you:refresh`
 * message (sent when a push lands), and keeps the last good response when
 * a read fails. While mounted it mirrors the count into the tab title
 * (`(N) Aquarium`) and the installed app's badge.
 *
 * `newIds` are the ids not yet acknowledged with `markSeen()`; the seen set
 * persists in localStorage so "new" survives a reload. The very first load
 * on a device seeds the set silently rather than flagging everything.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { NeedsYouEntry, NeedsYouResponse, NeedsYouSeverity } from "@/types/landing";

import { landingApi } from "./api";

export const NEEDS_YOU_POLL_MS = 15_000;
export const NEEDS_YOU_SEEN_KEY = "aquarium.needs-you.seen";
export const NEEDS_YOU_REFRESH_MESSAGE = "needs-you:refresh";
const BASE_TITLE = "Aquarium";
const COUNT_PREFIX = /^\(\d+\)\s+/;

/** `(N) <title>` when N > 0, the bare title otherwise. */
export function titleWithCount(title: string, count: number): string {
  const base = title.replace(COUNT_PREFIX, "") || BASE_TITLE;
  return count > 0 ? `(${count}) ${base}` : base;
}

function loadSeen(): Set<string> | null {
  try {
    const raw = window.localStorage.getItem(NEEDS_YOU_SEEN_KEY);
    if (raw === null) return null;
    const ids: unknown = JSON.parse(raw);
    return new Set(Array.isArray(ids) ? ids.filter((i): i is string => typeof i === "string") : []);
  } catch {
    return new Set();
  }
}

function saveSeen(ids: Iterable<string>): void {
  try {
    window.localStorage.setItem(NEEDS_YOU_SEEN_KEY, JSON.stringify([...ids]));
  } catch {
    // Private mode / quota: "new" just won't survive a reload.
  }
}

type BadgeNavigator = Navigator & {
  setAppBadge?: (n?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

function setBadge(count: number): void {
  const nav = navigator as BadgeNavigator;
  try {
    const p = count > 0 ? nav.setAppBadge?.(count) : (nav.clearAppBadge?.() ?? nav.setAppBadge?.(0));
    p?.catch(() => {});
  } catch {
    // Badging unsupported or not permitted: the title still carries it.
  }
}

export interface UseNeedsYou {
  items: NeedsYouEntry[];
  count: number;
  bySeverity: Record<NeedsYouSeverity, number>;
  /** Ids present now that were not there when `markSeen()` last ran. */
  newIds: string[];
  /** No response yet (first load still in flight or failing). */
  loading: boolean;
  /** The latest read failed; the data shown is the last good response. */
  stale: boolean;
  refresh: () => Promise<void>;
  /** Acknowledge everything currently listed. */
  markSeen: () => void;
}

const EMPTY_SEVERITY: Record<NeedsYouSeverity, number> = {
  blocking: 0,
  approval: 0,
  review: 0,
  fyi: 0,
};

export function useNeedsYou(): UseNeedsYou {
  const [data, setData] = useState<NeedsYouResponse | null>(null);
  const [stale, setStale] = useState(false);
  const [seen, setSeen] = useState<Set<string> | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    const run = (async () => {
      const next = await landingApi.needsYou();
      if (!mounted.current) return;
      if (!next || !Array.isArray(next.items)) {
        setStale(true);
        return;
      }
      setStale(false);
      setData(next);
      setSeen((prev) => {
        const current = prev ?? loadSeen();
        if (current === null) {
          const seeded = new Set(next.items.map((i) => i.id));
          saveSeen(seeded);
          return seeded;
        }
        return current;
      });
    })().finally(() => {
      inFlight.current = null;
    });
    inFlight.current = run;
    return run;
  }, []);

  useEffect(() => {
    mounted.current = true;
    const visible = () => document.visibilityState === "visible";
    void refresh();
    const timer = window.setInterval(() => {
      if (visible()) void refresh();
    }, NEEDS_YOU_POLL_MS);
    const onFocus = () => void refresh();
    const onVisibility = () => {
      if (visible()) void refresh();
    };
    const onMessage = (event: MessageEvent) => {
      const type = (event.data as { type?: unknown } | null)?.type;
      if (type === NEEDS_YOU_REFRESH_MESSAGE) void refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    const sw = typeof navigator !== "undefined" ? navigator.serviceWorker : undefined;
    sw?.addEventListener("message", onMessage);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      sw?.removeEventListener("message", onMessage);
    };
  }, [refresh]);

  const count = data?.count ?? 0;

  useEffect(() => {
    if (data === null) return;
    document.title = titleWithCount(document.title, count);
    setBadge(count);
  }, [data, count]);

  useEffect(
    () => () => {
      document.title = titleWithCount(document.title, 0);
    },
    [],
  );

  const items = useMemo(() => data?.items ?? [], [data]);
  const newIds = useMemo(
    () => (seen === null ? [] : items.map((i) => i.id).filter((id) => !seen.has(id))),
    [items, seen],
  );

  const markSeen = useCallback(() => {
    // Only what is listed now: an id that leaves and later returns is new again.
    const ids = new Set(items.map((i) => i.id));
    saveSeen(ids);
    setSeen(ids);
  }, [items]);

  return {
    items,
    count,
    bySeverity: data?.by_severity ?? EMPTY_SEVERITY,
    newIds,
    loading: data === null,
    stale,
    refresh,
    markSeen,
  };
}
