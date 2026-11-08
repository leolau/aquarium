"use client";

import Link from "next/link";

import { useT } from "@/i18n";
import { useHydrated } from "@/lib/use-hydrated";
import {
  buildInfo,
  fmtAge,
  fmtBuildTime,
  fmtGb,
  fmtPct,
  fmtTokens,
  resetStatusSummaryCache,
  useStatusSummary,
} from "@/components/ui/useStatusSummary";

export { fmtBuildTime };

export function resetStatusStripCache(): void {
  resetStatusSummaryCache();
}

/**
 * The ambient status strip under the header: CPU, storage, 30-day token
 * burn, live background work, and scheduled jobs. Polls while the tab is
 * visible and re-reads on focus; a failed read keeps the last good values
 * (a strip that blanks on every hiccup is worse than a stale one) but the
 * self-ticking "Ns ago" label — amber with "retrying" while fetches fail —
 * always says exactly how old the numbers are. The ↻ button re-reads now.
 * Data comes from `useStatusSummary` (shared with the landing top bar).
 */
export function StatusStrip() {
  const t = useT("nav");
  const { summary, stale, fetchedAt, now, refreshing, refresh: refreshOnce } =
    useStatusSummary();

  // A server/bundle SHA mismatch means this tab is running a pre-deploy
  // bundle — flag it instead of quietly showing old metrics forever.
  const { clientBuild, buildTimeIso, serverBuild, buildMismatch } = buildInfo(summary);
  // Local time in the browser's locale and zone: the server's differ, so the
  // stamp only renders once hydrated (else a React #418 text mismatch).
  const hydrated = useHydrated();
  const buildTime = hydrated ? fmtBuildTime(buildTimeIso) : null;

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
          onClick={() => void refreshOnce()}
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
