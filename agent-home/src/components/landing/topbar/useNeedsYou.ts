"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { landingApi } from "@/lib/landing/api";
import type { NeedsYouEntry, NeedsYouResponse, NeedsYouSeverity } from "@/types/landing";

/*
 * Minimal local adapter for the needs-you feed until the B3 workstream's
 * `@/lib/landing/needsYou` lands on the base branch. Same shape it is
 * expected to expose; swap the import in TopBar.tsx and delete this file.
 */

export const NEEDS_YOU_POLL_MS = 15_000;

export const SEVERITY_RANK: Record<NeedsYouSeverity, number> = {
  blocking: 0,
  approval: 1,
  review: 2,
  fyi: 3,
};

/** Most urgent first: severity, then oldest. */
export function sortNeedsYou(items: NeedsYouEntry[]): NeedsYouEntry[] {
  return [...items].sort(
    (a, b) =>
      (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) ||
      a.created_at - b.created_at,
  );
}

export interface NeedsYouState {
  data: NeedsYouResponse | null;
  /** null until the first successful read. */
  count: number | null;
  blocking: number;
  /** Most urgent first (empty for a count-only read). */
  items: NeedsYouEntry[];
  /** The latest read failed (404 not deployed yet, 502 upstream down). */
  stale: boolean;
  refresh(): Promise<void>;
}

const lastGood: Partial<Record<"full" | "count", NeedsYouResponse>> = {};

export function resetNeedsYouCache(): void {
  delete lastGood.full;
  delete lastGood.count;
}

export function useNeedsYou(opts?: { countOnly?: boolean }): NeedsYouState {
  const countOnly = Boolean(opts?.countOnly);
  const key = countOnly ? "count" : "full";
  const [data, setData] = useState<NeedsYouResponse | null>(() => lastGood[key] ?? null);
  const [stale, setStale] = useState(false);
  const mounted = useRef(true);
  const inFlight = useRef<Promise<void> | null>(null);

  const refresh = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    const run = (async () => {
      try {
        const next = await landingApi.needsYou({ countOnly });
        if (!mounted.current) return;
        if (next) {
          lastGood[key] = next;
          setData(next);
          setStale(false);
        } else {
          setStale(true);
        }
      } finally {
        inFlight.current = null;
      }
    })();
    inFlight.current = run;
    return run;
  }, [countOnly, key]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, NEEDS_YOU_POLL_MS);
    const wake = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    // sw.js posts this on a push so the badge updates before the next poll.
    const onSwMessage = (e: MessageEvent) => {
      if ((e.data as { type?: string } | null)?.type === "needs-you:refresh") void refresh();
    };
    const sw = typeof navigator !== "undefined" ? navigator.serviceWorker : undefined;
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    sw?.addEventListener("message", onSwMessage);
    return () => {
      mounted.current = false;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
      sw?.removeEventListener("message", onSwMessage);
    };
  }, [refresh]);

  const items = data?.items ? sortNeedsYou(data.items) : [];
  return {
    data,
    count: data ? (data.count ?? items.length) : null,
    blocking: data?.by_severity?.blocking ?? items.filter((i) => i.severity === "blocking").length,
    items,
    stale,
    refresh,
  };
}
