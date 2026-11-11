"use client";

import Link from "next/link";

import { ClockIcon } from "@/components/ui/icons";
import { fmtElapsed } from "@/components/ui/useActivityRunning";
import { useT, type Translator } from "@/i18n";
import type { ScheduledSummary } from "@/types";

/** Projects › Scheduled, forced into Project mode over a saved Task-mode preference. */
export const SCHEDULED_HREF = "/projects?view=project&schedule=set";

function part(t: Translator, key: string, count: number): string {
  return count === 1 ? t(`scheduled.${key}One`) : t(`scheduled.${key}Many`, { count });
}

/** "3 projects · 2 cards · 1 job · next in 2h 00m"; zero parts are left out. */
export function scheduledTooltip(summary: ScheduledSummary, now: number, t: Translator): string {
  const parts = [
    summary.projects ? part(t, "projects", summary.projects) : null,
    summary.cards ? part(t, "cards", summary.cards) : null,
    summary.cron_jobs ? part(t, "jobs", summary.cron_jobs) : null,
  ].filter((p): p is string => Boolean(p));
  if (parts.length === 0) return t("scheduled.none");
  const nextMs = summary.next_run_at !== null ? summary.next_run_at * 1000 - now : null;
  if (nextMs !== null && nextMs > 0) parts.push(t("scheduled.nextIn", { time: fmtElapsed(nextMs) }));
  return parts.join(" · ");
}

/**
 * "◷ Scheduled N": everything set to start later (project schedules, parked
 * cards, admins' standalone jobs), opening Projects › Scheduled. `compact` is
 * the phone variant ("◷ N", a 44 px target).
 */
export function ScheduledButton({
  summary,
  now,
  compact = false,
  className = "",
}: {
  summary: ScheduledSummary;
  now: number;
  compact?: boolean;
  className?: string;
}) {
  const t = useT("landing");
  const total = Math.max(0, summary.total ?? 0);
  return (
    <Link
      href={SCHEDULED_HREF}
      data-component="ScheduledButton"
      data-variant={compact ? "compact" : "full"}
      title={scheduledTooltip(summary, now, t)}
      aria-label={t("scheduled.aria", { count: total })}
      className={
        compact
          ? `inline-flex h-11 min-w-11 shrink-0 items-center justify-center gap-1 rounded-[var(--radius-full)] px-2 text-xs font-medium text-[var(--color-fg)] hover:bg-[var(--color-surface-2)] ${className}`
          : `inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[var(--radius-full)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[13px] font-medium text-[var(--color-fg)] hover:bg-[var(--color-surface-2)] ${className}`
      }
    >
      <ClockIcon size={compact ? 14 : 16} className="text-[var(--color-muted)]" />
      {compact ? null : <span aria-hidden="true">{t("scheduled.button")}</span>}
      <span aria-hidden="true" data-testid="scheduled-count" className="font-semibold tabular-nums">
        {total}
      </span>
    </Link>
  );
}
