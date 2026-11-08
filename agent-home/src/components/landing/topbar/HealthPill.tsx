"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";

import { Sheet } from "@/components/ui/Sheet";
import {
  buildInfo,
  fmtAge,
  fmtBuildTime,
  fmtGb,
  fmtPct,
  fmtTokens,
  type StatusSummaryState,
} from "@/components/ui/useStatusSummary";
import type { ActivityRunningState } from "@/components/ui/useActivityRunning";
import { useT } from "@/i18n";
import { useHydrated } from "@/lib/use-hydrated";

import { ActivityList } from "./ActivityList";
import { VERDICT_DOT, VERDICT_LABEL, healthVerdict } from "./health";
import {
  ClockIcon,
  CoinsIcon,
  CpuIcon,
  HardDriveIcon,
  PlayIcon,
  RefreshIcon,
} from "./icons";
import { usePopover } from "./usePopover";

type Status = Pick<StatusSummaryState, "summary" | "stale" | "fetchedAt" | "now" | "refreshing" | "refresh">;
type Activity = Pick<ActivityRunningState, "items" | "now" | "stale">;

function readings(status: Status) {
  const s = status.summary;
  const tokensTotal = s?.tokens_month ? s.tokens_month.input + s.tokens_month.output : null;
  const cost = s?.tokens_month?.cost_usd ?? null;
  return {
    cpu: fmtPct(s?.cpu_pct),
    mem: fmtPct(s?.mem_pct),
    disk: fmtPct(s?.disk_pct),
    tokens: tokensTotal !== null ? `${fmtTokens(tokensTotal)} / mo` : null,
    cost: cost ? `$${cost.toFixed(2)} / mo` : null,
    live: s ? String((s.active_conversations ?? 0) + (s.running_cards ?? 0)) : "—",
    scheduled: s ? `${s.cron_enabled} / ${s.cron_total}` : "—",
  };
}

function Freshness({ status, prefix = "Updated " }: { status: Status; prefix?: string }) {
  if (status.fetchedAt === null) return null;
  return (
    <span
      data-testid="health-freshness"
      title="How old these numbers are — re-read every 30s"
      className={`whitespace-nowrap ${status.stale ? "text-[var(--color-warn-text)]" : "text-[var(--color-muted)]"}`}
    >
      {prefix}
      {fmtAge(status.now - status.fetchedAt)}
      {status.stale ? " · retrying" : ""}
    </span>
  );
}

function RefreshButton({ status }: { status: Status }) {
  return (
    <button
      type="button"
      onClick={() => void status.refresh()}
      disabled={status.refreshing}
      aria-busy={status.refreshing || undefined}
      aria-label="Refresh now"
      title="Refresh now"
      data-action="status-refresh"
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-fg)] disabled:opacity-50"
    >
      <RefreshIcon size={14} className={status.refreshing ? "animate-spin" : undefined} />
    </button>
  );
}

/** Figma `health-metric` (3:40): icon, muted label, value. */
function Metric({ icon, label, value, className = "" }: { icon: ReactNode; label: string; value: string; className?: string }) {
  return (
    <span data-component="health-metric" className={`inline-flex items-center gap-1 whitespace-nowrap ${className}`}>
      <span className="text-[var(--color-muted)]">{icon}</span>
      <span className="text-[var(--color-muted)]">{label}</span>
      <span className="text-[var(--color-fg)]">{value}</span>
    </span>
  );
}

function ReadingRow({ label, value, href, title }: { label: string; value: ReactNode; href?: string; title?: string }) {
  const inner = (
    <>
      <dt className="text-[var(--color-muted)]">{label}</dt>
      <dd className="text-right font-medium text-[var(--color-fg)]">{value}</dd>
    </>
  );
  const cls = "flex items-center justify-between gap-3 rounded-[var(--radius-sm)] px-2 py-1";
  return href ? (
    <Link href={href} title={title} className={`${cls} hover:bg-[var(--color-surface-2)]`}>
      {inner}
    </Link>
  ) : (
    <div title={title} className={cls}>
      {inner}
    </div>
  );
}

/** The full readings: shown in the desktop popover and the mobile sheet. */
export function HealthReadings({ status, activity }: { status: Status; activity?: Activity }) {
  const t = useT("nav");
  const hydrated = useHydrated();
  const build = buildInfo(status.summary);
  const { verdict, reasons } = healthVerdict({
    summary: status.summary,
    stale: status.stale,
    buildMismatch: build.buildMismatch,
  });
  const r = readings(status);
  const s = status.summary;
  const storage = s?.upload_storage ?? null;
  const buildTime = hydrated ? fmtBuildTime(build.buildTimeIso) : null;
  return (
    <div data-component="HealthReadings" className="flex flex-col gap-3 text-xs">
      <div className="flex items-center gap-2">
        <span aria-hidden className={`h-2 w-2 rounded-full ${VERDICT_DOT[verdict]}`} />
        <span className="text-sm font-semibold text-[var(--color-fg)]">{VERDICT_LABEL[verdict]}</span>
        <span className="ml-auto flex items-center gap-1">
          <Freshness status={status} />
          <RefreshButton status={status} />
        </span>
      </div>
      {reasons.length ? (
        <ul className="list-disc pl-5 text-[var(--color-warn-text)]">
          {reasons.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      ) : null}
      {storage?.low ? (
        <div
          role="alert"
          data-component="LowStorageWarning"
          className="rounded-[var(--radius-md)] border border-[var(--color-warn)] bg-[var(--color-attention-bg)] px-3 py-2 text-[var(--color-warn-text)]"
        >
          Upload storage is running low: {fmtGb(storage.free_bytes)} free of {fmtGb(storage.total_bytes)}.
          Free up space or add disk before large uploads start failing.
        </div>
      ) : null}
      {build.buildMismatch ? (
        <button
          type="button"
          data-action="build-reload"
          onClick={() => window.location.reload()}
          title={`This tab is running ${build.clientBuild} but the server is on ${build.serverBuild} — tap to reload`}
          className="rounded-[var(--radius-md)] bg-[var(--color-warn)] px-3 py-2 text-left font-medium text-[var(--color-bg)]"
        >
          Update {build.serverBuild} available · reload
        </button>
      ) : null}
      <dl className="flex flex-col">
        <ReadingRow label={t("status.cpu")} value={r.cpu} href="/capacity" title={t("status.cpuTitle")} />
        <ReadingRow label="Memory" value={r.mem} href="/capacity" />
        <ReadingRow label={t("status.disk")} value={r.disk} href="/capacity" title={t("status.diskTitle")} />
        {storage && storage.free_bytes !== null ? (
          <ReadingRow
            label="Upload storage"
            value={`${fmtGb(storage.free_bytes)} free of ${fmtGb(storage.total_bytes)}`}
            href="/capacity"
          />
        ) : null}
        {r.tokens ? (
          <ReadingRow
            label={t("status.tokens")}
            value={r.cost ? `${r.tokens} · ${r.cost.replace(" / mo", "")}` : r.tokens}
            href="/models"
            title={t("status.tokensTitle")}
          />
        ) : null}
        <ReadingRow label="Live work" value={r.live} title={t("status.tasksTitle")} />
        <ReadingRow label="Scheduled" value={r.scheduled} title={t("status.cronTitle")} />
      </dl>
      {activity ? (
        <section aria-label="Running now" className="flex flex-col gap-1">
          <h3 className="px-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
            Running now {activity.items.length ? `· ${activity.items.length}` : ""}
          </h3>
          <div className={activity.stale ? "opacity-60" : undefined}>
            <ActivityList items={activity.items} now={activity.now} />
          </div>
        </section>
      ) : null}
      <p
        className="px-2 font-mono text-[11px] text-[var(--color-muted)]"
        title={`agent-home build ${build.clientBuild}${build.buildTimeIso ? `, built ${build.buildTimeIso}` : ""}`}
      >
        {build.clientBuild}
        {buildTime ? <span data-testid="build-time" className="font-sans"> · {buildTime}</span> : null}
      </p>
    </div>
  );
}

/**
 * Health in the top bar (Figma `health-bar` 5:10 desktop, `health-pill` 6:97
 * mobile). Desktop: dot + CPU/Disk/Tokens/Live/Scheduled + freshness + ↻,
 * click for a popover with every reading and what's running. Mobile: a dot
 * and verdict label that opens the same readings in a sheet. Failed reads
 * keep the last good numbers, dimmed, with "retrying".
 */
export function HealthPill({
  status,
  activity,
  variant,
  className = "",
}: {
  status: Status;
  activity?: Activity;
  variant: "bar" | "compact";
  className?: string;
}) {
  const t = useT("nav");
  const { open: popOpen, setOpen: setPopOpen, ref: popRef } = usePopover();
  const [sheet, setSheet] = useState(false);
  const build = buildInfo(status.summary);
  const { verdict } = healthVerdict({
    summary: status.summary,
    stale: status.stale,
    buildMismatch: build.buildMismatch,
  });
  const r = readings(status);
  const lowStorage = Boolean(status.summary?.upload_storage?.low);

  if (variant === "compact") {
    return (
      <>
        <button
          type="button"
          data-component="HealthPill"
          data-variant="compact"
          data-verdict={verdict}
          data-stale={status.stale || undefined}
          aria-haspopup="dialog"
          aria-label={`System health: ${VERDICT_LABEL[verdict]} — show readings`}
          onClick={() => setSheet(true)}
          className={`inline-flex h-6 shrink-0 items-center gap-1 rounded-full bg-[var(--color-surface)] px-2 text-xs font-medium text-[var(--color-muted)] ${className}`}
        >
          <span aria-hidden className={`h-2 w-2 rounded-full ${VERDICT_DOT[verdict]}`} />
          {build.buildMismatch ? "Update" : VERDICT_LABEL[verdict]}
        </button>
        {sheet ? (
          <Sheet title="System health" onClose={() => setSheet(false)} component="HealthSheet">
            <HealthReadings status={status} activity={activity} />
          </Sheet>
        ) : null}
      </>
    );
  }

  return (
    <div
      ref={popRef}
      data-component="HealthPill"
      data-variant="bar"
      data-verdict={verdict}
      data-stale={status.stale || undefined}
      className={`relative flex min-w-0 items-center gap-2 ${className}`}
    >
      <div
        className={`flex h-6 min-w-0 items-center gap-4 rounded-full bg-[var(--color-surface)] px-3 text-xs font-medium ${
          status.stale ? "opacity-70" : ""
        }`}
      >
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={popOpen}
          aria-label={`System health: ${VERDICT_LABEL[verdict]} — show all readings`}
          data-action="health-open"
          onClick={() => setPopOpen((v) => !v)}
          className="flex min-w-0 items-center gap-4 overflow-hidden"
        >
          <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${VERDICT_DOT[verdict]}`} />
          <Metric icon={<CpuIcon size={14} />} label={t("status.cpu")} value={r.cpu} />
          <Metric icon={<HardDriveIcon size={14} />} label={t("status.disk")} value={r.disk} />
          {r.cost || r.tokens ? (
            <Metric
              icon={<CoinsIcon size={14} />}
              label={t("status.tokens")}
              value={(r.cost ?? r.tokens)!}
              className="hidden xl:inline-flex"
            />
          ) : null}
          <Metric icon={<PlayIcon size={14} />} label="Live" value={r.live} />
          <Metric
            icon={<ClockIcon size={14} />}
            label="Scheduled"
            value={r.scheduled}
            className="hidden xl:inline-flex"
          />
        </button>
        <Freshness status={status} />
        <RefreshButton status={status} />
      </div>
      {build.buildMismatch || lowStorage ? (
        <span className="flex h-6 shrink-0 items-center gap-2">
          {build.buildMismatch ? (
            <button
              type="button"
              data-action="build-reload"
              onClick={() => window.location.reload()}
              title={`This tab is running ${build.clientBuild} but the server is on ${build.serverBuild} — tap to reload`}
              className="whitespace-nowrap rounded-full bg-[var(--color-warn)] px-2 py-0.5 text-xs font-medium text-[var(--color-bg)]"
            >
              update {build.serverBuild} · refresh
            </button>
          ) : null}
          {lowStorage ? (
            <button
              type="button"
              onClick={() => setPopOpen(true)}
              className="whitespace-nowrap rounded-full bg-[var(--color-attention-bg)] px-2 py-0.5 text-xs font-medium text-[var(--color-warn-text)]"
            >
              Low storage
            </button>
          ) : null}
        </span>
      ) : null}
      {popOpen ? (
        <div
          role="dialog"
          aria-label="System health"
          className="absolute left-0 top-full z-40 mt-2 w-80 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg)] p-3 shadow-xl"
        >
          <HealthReadings status={status} activity={activity} />
        </div>
      ) : null}
    </div>
  );
}
