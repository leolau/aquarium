"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export const POLL_MS = 15_000;

export interface PolledCache<T> {
  value: T;
  at: number;
}

/**
 * Poll `read` every `POLL_MS` while the tab is visible and re-read on focus.
 * `read` resolves `null` on failure: the last good value is kept and
 * `stale` turns on. One read at a time; `refresh()` joins an in-flight read.
 * `cache` holds the last good value across mounts so a remount within the
 * poll interval does not re-fetch.
 */
export function usePolled<T>(
  read: () => Promise<T | null>,
  cache: { current: PolledCache<T> | null },
  onValue?: (value: T) => void,
): { value: T | null; stale: boolean; loaded: boolean; refresh: () => Promise<void> } {
  const [value, setValue] = useState<T | null>(() => cache.current?.value ?? null);
  const [stale, setStale] = useState(false);
  const mounted = useRef(true);
  const inFlight = useRef<Promise<void> | null>(null);
  const readRef = useRef(read);
  const onValueRef = useRef(onValue);
  useLayoutEffect(() => {
    readRef.current = read;
    onValueRef.current = onValue;
  });

  const refresh = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    const run = (async () => {
      try {
        const next = await readRef.current().catch(() => null);
        if (next === null) {
          if (mounted.current) setStale(true);
          return;
        }
        cache.current = { value: next, at: Date.now() };
        if (mounted.current) {
          onValueRef.current?.(next);
          setValue(next);
          setStale(false);
        }
      } finally {
        inFlight.current = null;
      }
    })();
    inFlight.current = run;
    return run;
  }, [cache]);

  useEffect(() => {
    mounted.current = true;
    if (!cache.current || Date.now() - cache.current.at >= POLL_MS) void refresh();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    const wake = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    return () => {
      mounted.current = false;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
    };
  }, [cache, refresh]);

  return { value, stale, loaded: value !== null, refresh };
}

/** A local clock that ticks only while `active` and the tab is visible. */
export function useNow(active: boolean, tickMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const sync = () => {
      if (document.visibilityState === "visible") setNow(Date.now());
    };
    const first = setTimeout(sync, 0);
    const t = setInterval(sync, tickMs);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [active, tickMs]);
  return now;
}
