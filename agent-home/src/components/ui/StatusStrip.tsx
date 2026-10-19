"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import type { StatusSummary } from "@/types";
import { useT } from "@/i18n";

const POLL_MS = 30_000;
const AGE_TICK_MS = 1_000;

function fmtPct(v: number | null): string {
  return v === null ? "—" : `${Math.round(v)}%`;
}

function fmtAge(ms: number): string {
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

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return `${n}`;
}

function fmtGb(bytes: number | null): string {
  return bytes === null ? "—" : `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * The ambient status strip under the header: CPU, storage, 30-day token
 * burn, live background work, and scheduled jobs. Polls while the tab is
 * visible and re-reads on focus; a failed read keeps the last good values
 * (a strip that blanks on every hiccup is worse than a stale one) but the
 * self-ticking "Ns ago" label — amber with "retrying" while fetches fail —
 * always says exactly how old the numbers are. The ↻ button re-reads now.
 */
export function StatusStrip() {
  const t = useT("nav");
  const [summary, setSummary] = useState<StatusSummary | null>(null);
  const [stale, setStale] = useState(false);
  // When the last *successful* fetch landed (local clock — immune to server/
  // browser clock skew) and a 1s heartbeat so the age label self-ticks.
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(true);
  // One read at a time: the poll, focus wake and the ↻ button share it.
  const inFlight = useRef<Promise<void> | null>(null);

  const tick = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    const run = (async () => {
      try {
        const res = await fetch("/api/status/summary", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as StatusSummary;
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

  useEffect(() => {
    mounted.current = true;
    void tick();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") void tick();
    }, POLL_MS);
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

  // Self-ticking clock for the "Ns ago" freshness label — skipped while the
  // tab is hidden so background tabs don't burn a render a second.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") setNow(Date.now());
    }, AGE_TICK_MS);
    return () => clearInterval(t);
  }, []);

  // The browser bundle's own SHA vs the one the server reports. A mismatch
  // means this tab is running a pre-deploy bundle — flag it instead of
  // quietly showing old metrics forever.
  const clientBuild = process.env.NEXT_PUBLIC_HERMES_BUILD ?? "dev";
  const buildTimeIso = process.env.NEXT_PUBLIC_HERMES_BUILD_TIME;
  const buildTime = fmtBuildTime(buildTimeIso);
  const serverBuild = summary?.build ?? null;
  const buildMismatch = serverBuild !== null && serverBuild !== clientBuild;

  const tokens = summary?.tokens_month
    ? fmtTokens(summary.tokens_month.input + summary.tokens_month.output)
    : null;
  const cost = summary?.tokens_month?.cost_usd;
  const tasks =
    (summary?.active_conversations ?? 0) + (summary?.running_cards ?? 0);

  const lowStorage = summary?.upload_storage?.low ? summary.upload_storage : null;

  const chip =
    "inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-[var(--color-surface-2)] px-2 py-0.5";

  return (
    <div
      data-component="StatusStrip"
      data-stale={stale || undefined}
      className={`overflow-x-auto border-b border-[var(--color-border)] px-4 py-1.5 text-[11px] text-[var(--color-muted)] lg:px-8 ${
        stale ? "opacity-60" : ""
      }`}
    >
      {lowStorage ? (
        <div
          role="alert"
          data-component="LowStorageWarning"
          className="mx-auto mb-1.5 w-full max-w-2xl rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-[12px] text-amber-700 dark:text-amber-300 lg:max-w-5xl"
        >
          Upload storage is running low: {fmtGb(lowStorage.free_bytes)} free of{" "}
          {fmtGb(lowStorage.total_bytes)}. Free up space or add disk before large uploads
          start failing.
        </div>
      ) : null}
      <div className="mx-auto flex w-full max-w-2xl items-center gap-2 lg:max-w-5xl">
        <Link href="/capacity" className={chip} title={t("status.cpuTitle")}>
          <span className="font-medium text-[var(--color-fg)]">{t("status.cpu")}</span>
          {fmtPct(summary?.cpu_pct ?? null)}
        </Link>
        <Link href="/capacity" className={chip} title={t("status.diskTitle")}>
          <span className="font-medium text-[var(--color-fg)]">{t("status.disk")}</span>
          {fmtPct(summary?.disk_pct ?? null)}
        </Link>
        {tokens ? (
          <Link
            href="/models"
            className={chip}
            title={t("status.tokensTitle")}
          >
            <span className="font-medium text-[var(--color-fg)]">{t("status.tokens")}</span>
            {tokens}/mo
            {cost ? ` · $${cost.toFixed(2)}` : ""}
          </Link>
        ) : null}
        <span className={chip} title={t("status.tasksTitle")}>
          <span className="font-medium text-[var(--color-fg)]">{t("status.tasks")}</span>
          {tasks}
        </span>
        <span className={chip} title={t("status.cronTitle")}>
          <span className="font-medium text-[var(--color-fg)]">{t("status.cron")}</span>
          {summary ? `${summary.cron_enabled}/${summary.cron_total}` : "—"}
        </span>
        {fetchedAt !== null ? (
          <span
            title="How old these numbers are — the strip re-reads the server every 30s"
            className={stale ? "text-[var(--color-warn-text)]" : undefined}
          >
            {fmtAge(now - fetchedAt)}
            {stale ? " · retrying" : ""}
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => void refreshNow()}
          disabled={refreshing}
          aria-busy={refreshing || undefined}
          aria-label="Refresh now"
          title="Refresh now"
          data-action="status-refresh"
          className="inline-flex h-5 w-5 items-center justify-center rounded-full hover:bg-[var(--color-surface-2)] hover:text-[var(--color-fg)] disabled:opacity-50"
        >
          <span aria-hidden className={refreshing ? "inline-block animate-spin" : undefined}>
            ↻
          </span>
        </button>
        {buildMismatch ? (
          <button
            type="button"
            onClick={() => window.location.reload()}
            title={`This tab is running ${clientBuild} but the server is on ${serverBuild} — tap to reload`}
            className="ml-auto inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-amber-500/20 px-2 py-0.5 font-medium text-[var(--color-warn-text)]"
          >
            update {serverBuild} · refresh
          </button>
        ) : (
          <span
            className="ml-auto whitespace-nowrap rounded-full px-2 py-0.5 font-mono"
            title={`agent-home build ${clientBuild}${buildTimeIso ? `, built ${buildTimeIso}` : ""}`}
          >
            {clientBuild}
            {buildTime ? (
              <span data-testid="build-time" className="font-sans">
                {" · "}
                {buildTime}
              </span>
            ) : null}
          </span>
        )}
      </div>
    </div>
  );
}
