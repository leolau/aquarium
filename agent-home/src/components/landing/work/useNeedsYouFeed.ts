"use client";

import { useCallback, useState } from "react";

import { landingApi } from "@/lib/landing/api";
import type { NeedsYouEntry, NeedsYouResponse } from "@/types/landing";

import { type PolledCache, usePolled } from "./usePolled";

/**
 * Local adapter for the needs-you list until `useNeedsYou()` from
 * `src/lib/landing/needsYou.ts` lands: `GET /api/needs-you` every 15 s while
 * visible, re-read on focus, last good data kept on a 404/502.
 *
 * `newIds` are the entries that appeared since the previous good read (never
 * on the first read, so a page load does not flash everything as new).
 */
export interface NeedsYouFeed {
  items: NeedsYouEntry[];
  count: number;
  newIds: ReadonlySet<string>;
  loaded: boolean;
  stale: boolean;
  refresh: () => Promise<void>;
}

const cache: { current: PolledCache<NeedsYouResponse> | null } = { current: null };
let seenIds: Set<string> | null = null;

export function resetNeedsYouFeedCache(): void {
  cache.current = null;
  seenIds = null;
}

const EMPTY: ReadonlySet<string> = new Set();

export function useNeedsYouFeed(): NeedsYouFeed {
  const [newIds, setNewIds] = useState<ReadonlySet<string>>(EMPTY);
  const read = useCallback(() => landingApi.needsYou(), []);
  const onValue = useCallback((data: NeedsYouResponse) => {
    const ids = (Array.isArray(data.items) ? data.items : []).map((i) => i.id);
    const prev = seenIds;
    seenIds = new Set(ids);
    if (!prev) return;
    setNewIds((current) => {
      // Keep an entry "new" until it leaves the list, so the highlight
      // survives the next poll instead of blinking off after 15 s.
      const next = new Set<string>();
      for (const id of ids) if (!prev.has(id) || current.has(id)) next.add(id);
      return next.size === 0 && current.size === 0 ? current : next;
    });
  }, []);
  const { value, stale, loaded, refresh } = usePolled(read, cache, onValue);
  const items = Array.isArray(value?.items) ? value.items : [];
  return {
    items,
    count: typeof value?.count === "number" ? value.count : items.length,
    newIds,
    loaded,
    stale,
    refresh,
  };
}
