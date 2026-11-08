"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { StatusSummary } from "@/types";
import { useAction } from "@/lib/use-action";

export const STATUS_POLL_MS = 30_000;
const AGE_TICK_MS = 1_000;

export function fmtPct(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : `${Math.round(v)}%`;
}

export function fmtAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 3) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

/** Short local date/time for the build stamp, e.g. "4 Oct 07:04". */
export function fmtBuildTime(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return `${n}`;
}

export function fmtGb(bytes: number | null): string {
  return bytes === null ? "—" : `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

// Last good read, shared across mounts (and across every consumer: the
// StatusStrip and the landing top bar). MobileShell renders per page, so
// every client navigation remounts the strip. A read younger than the poll
// interval is reused instead of re-firing the summary's upstream fan-out.
let lastGood: { summary: StatusSummary; at: number } | null = null;

export function resetStatusSummaryCache(): void {
  lastGood = null;
}

export interface StatusSummaryState {
  summary: StatusSummary | null;
  /** The latest read failed; `summary` is the last good one. */
  stale: boolean;
  /** Local clock of the last successful read, or null before the first. */
  fetchedAt: number | null;
  /** Self-ticking clock (1 s while visible) for "Ns ago" labels. */
  now: number;
  refreshing: boolean;
  /** Re-read now (click-locked; shares the in-flight read). */
  refresh(): Promise<void>;
}

/**
 * `GET /api/status/summary` polled every 30 s while the tab is visible and
 * re-read on focus. A failed read keeps the last good values and flags
 * `stale`. One read at a time per consumer: the poll, focus wake and the
 * refresh button share it.
 */
export function useStatusSummary(): StatusSummaryState {
  const [summary, setSummary] = useState<StatusSummary | null>(
    () => lastGood?.summary ?? null,
  );
  const [stale, setStale] = useState(false);
  // Local clock — immune to server/browser clock skew.
  const [fetchedAt, setFetchedAt] = useState<number | null>(
    () => lastGood?.at ?? null,
  );
  const [now, setNow] = useState(() => Date.now());
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(true);
  const inFlight = useRef<Promise<void> | null>(null);

  const tick = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    const run = (async () => {
      try {
        const res = await fetch("/api/status/summary", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as StatusSummary;
        lastGood = { summary: data, at: Date.now() };
        if (mounted.current) {
          setSummary(data);
          setFetchedAt(Date.now());
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

  const refreshNow = useCallback(async () => {
    setRefreshing(true);
    try {
      await tick();
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }, [tick]);
  const { run: refreshOnce } = useAction(refreshNow);
  const refresh = useCallback(async () => {
    await refreshOnce();
  }, [refreshOnce]);

  useEffect(() => {
    mounted.current = true;
    if (!lastGood || Date.now() - lastGood.at >= STATUS_POLL_MS) void tick();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") void tick();
    }, STATUS_POLL_MS);
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

  // Skipped while the tab is hidden so background tabs don't burn a render
  // a second.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") setNow(Date.now());
    }, AGE_TICK_MS);
    return () => clearInterval(t);
  }, []);

  return { summary, stale, fetchedAt, now, refreshing, refresh };
}

export interface BuildInfo {
  clientBuild: string;
  buildTimeIso: string | undefined;
  serverBuild: string | null;
  /** This tab runs a pre-deploy bundle: the server reports another SHA. */
  buildMismatch: boolean;
}

/** The browser bundle's own SHA vs the one the server reports. */
export function buildInfo(summary: StatusSummary | null): BuildInfo {
  const clientBuild = process.env.NEXT_PUBLIC_HERMES_BUILD ?? "dev";
  const buildTimeIso = process.env.NEXT_PUBLIC_HERMES_BUILD_TIME;
  const serverBuild = summary?.build ?? null;
  return {
    clientBuild,
    buildTimeIso,
    serverBuild,
    buildMismatch: serverBuild !== null && serverBuild !== clientBuild,
  };
}
