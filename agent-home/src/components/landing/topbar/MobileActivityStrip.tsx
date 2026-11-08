"use client";

import { useState } from "react";

import { activityTiming } from "@/components/ui/useActivityRunning";
import type { ActivityItem } from "@/types";

import { ActivityList } from "./ActivityList";
import { ChevronDownIcon, PlayIcon } from "./icons";

/**
 * Mobile one-line activity strip (Figma `activity-strip` 6:107): "4 working ·
 * Market research · Website relaunch …" — tap to expand the full list.
 * Renders nothing when nothing is running; dims while reads are failing.
 */
export function MobileActivityStrip({
  items,
  now,
  stale = false,
  className = "",
}: {
  items: ActivityItem[];
  now: number;
  stale?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
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
      <button
        type="button"
        aria-expanded={open}
        aria-controls="mobile-activity-list"
        data-action="activity-expand"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-2 text-left font-medium"
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
      {open ? (
        <div id="mobile-activity-list" className="max-h-72 overflow-y-auto px-2 pb-2">
          <ActivityList items={items} now={now} />
        </div>
      ) : null}
    </div>
  );
}
