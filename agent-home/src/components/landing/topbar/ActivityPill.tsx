"use client";

import { useState } from "react";

import { PlayIcon } from "@/components/ui/icons";
import { Sheet } from "@/components/ui/Sheet";
import type { ActivityItem } from "@/types";

import { ActivityList } from "./ActivityList";

/**
 * The phone chat page's running indicator: "▶ 6" in the top bar instead of
 * the full-width activity strip. Tapping it lists what runs in a sheet.
 * Renders nothing while nothing runs.
 */
export function ActivityPill({ items, now, stale }: { items: ActivityItem[]; now: number; stale: boolean }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return (
    <>
      <button
        type="button"
        data-component="ActivityPill"
        data-action="activity-pill"
        data-stale={stale || undefined}
        onClick={() => setOpen(true)}
        aria-label={`${items.length} working — show what's running`}
        className={`inline-flex h-8 min-w-11 shrink-0 justify-center items-center gap-1 rounded-[var(--radius-full)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-[13px] font-semibold tabular-nums text-[var(--color-fg)] ${
          stale ? "opacity-60" : ""
        }`}
      >
        <PlayIcon size={12} className="text-[var(--color-success)]" />
        {items.length}
      </button>
      {open ? (
        <Sheet title="Running now" component="ActivitySheet" onClose={() => setOpen(false)}>
          <ActivityList items={items} now={now} />
        </Sheet>
      ) : null}
    </>
  );
}
