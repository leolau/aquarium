"use client";

import Link from "next/link";
import { useState } from "react";

import { activityTiming } from "@/components/ui/useActivityRunning";
import { useT } from "@/i18n";
import type { ActivityItem, ScheduledSummary } from "@/types";

import { ActivityList } from "./ActivityList";
import { SCHEDULED_HREF, ScheduledButton } from "./ScheduledButton";
import { ChevronDownIcon, PlayIcon } from "@/components/ui/icons";

/**
 * Mobile one-line activity strip (Figma `activity-strip` 6:107): "4 working ·
 * Market research · Website relaunch …" — tap to expand the full list. A
 * compact "◷ N" Scheduled link sits at the right end (outside the expand
 * button) and the expanded list ends with "N scheduled → Projects". Renders
 * nothing when nothing runs and nothing is scheduled; dims while reads fail.
 */
export function MobileActivityStrip({
  items,
  now,
  stale = false,
  scheduled = null,
  className = "",
}: {
  items: ActivityItem[];
  now: number;
  stale?: boolean;
  scheduled?: ScheduledSummary | null;
  className?: string;
}) {
  const t = useT("landing");
  const [open, setOpen] = useState(false);
  const scheduledTotal = scheduled?.total ?? 0;
  if (items.length === 0 && scheduledTotal === 0) return null;
  const waiting = items.filter((i) => i.status === "waiting").length;
  const anyLong = items.some((i) => activityTiming(i, now).long);
  const names = items.map((i) => i.name).join(" · ");
  return (
    <div
      data-component="MobileActivityStrip"
      data-stale={stale || undefined}
      className={`border-b border-[var(--color-border)] bg-[var(--color-bg)] text-xs ${
        stale ? "opacity-60" : ""
      } ${className}`}
    >
      <div className="flex items-center pr-1">
        {items.length > 0 ? (
          <button
            type="button"
            aria-expanded={open}
            aria-controls="mobile-activity-list"
            data-action="activity-expand"
            onClick={() => setOpen((v) => !v)}
            className="flex min-w-0 flex-1 items-center gap-2 py-2 pl-4 pr-2 text-left font-medium"
          >
            <PlayIcon
              size={14}
              className={anyLong ? "text-[var(--color-warn)]" : "text-[var(--color-accent)]"}
            />
            <span data-testid="activity-count" className="shrink-0 text-[var(--color-fg)]">
              {items.length} working
              {waiting ? <span className="text-[var(--color-warn-text)]"> · {waiting} waiting</span> : null}
            </span>
            <span aria-hidden className="text-[var(--color-muted)]">
              ·
            </span>
            <span className="min-w-0 flex-1 truncate text-[var(--color-muted)]">{names}</span>
            <ChevronDownIcon
              size={14}
              className={`text-[var(--color-muted)] transition-transform ${open ? "rotate-180" : ""}`}
            />
          </button>
        ) : (
          <p data-testid="activity-empty" className="min-w-0 flex-1 truncate py-2 pl-4 text-[var(--color-muted)]">
            {t("running.nothing")}
          </p>
        )}
        {scheduled ? <ScheduledButton compact summary={scheduled} now={now} /> : null}
      </div>
      {open ? (
        <div id="mobile-activity-list" className="max-h-72 overflow-y-auto px-2 pb-2">
          <ActivityList items={items} now={now} />
          {scheduled ? (
            <Link
              href={SCHEDULED_HREF}
              data-action="scheduled-footer"
              className="mt-1 flex items-center rounded-[var(--radius-md)] px-2 py-2 text-[12px] font-medium text-[var(--color-accent)] hover:bg-[var(--color-surface-2)]"
            >
              {t("scheduled.footer", { count: scheduledTotal })}
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
