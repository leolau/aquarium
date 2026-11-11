"use client";

import Link from "next/link";

import type { ActivityRunningState } from "@/components/ui/useActivityRunning";
import type { ActivityItem } from "@/types";

import { SectionHeader } from "./SectionHeader";
import { WorkRow, workStatus } from "./WorkRow";
import { useNow } from "./usePolled";

const CLOCK_TICK_MS = 1_000;
export const WORK_ROWS_MAX = 6;
const STATUS_RANK = { waiting: 0, long: 1, running: 2 } as const;

/** Waiting on a human first, then long runs, then the rest (server order). */
export function sortWork(items: ActivityItem[], now: number): ActivityItem[] {
  return items
    .map((item, i) => ({ item, i, rank: STATUS_RANK[workStatus(item, now)] }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.item);
}

export interface WorkPanelViewProps {
  items: ActivityItem[];
  loaded: boolean;
  stale: boolean;
  max?: number;
}

/**
 * "Working in the background": chats, project runs, kanban cards and cron
 * jobs running or waiting now, with a ticking elapsed time.
 */
export function WorkPanelView({ items, loaded, stale, max = WORK_ROWS_MAX }: WorkPanelViewProps) {
  const now = useNow(items.length > 0, CLOCK_TICK_MS);
  const sorted = sortWork(items, now);
  const shown = sorted.slice(0, max);
  const hidden = sorted.length - shown.length;

  return (
    <section
      data-component="WorkPanel"
      data-stale={stale || undefined}
      aria-labelledby="work-heading"
      className={`flex flex-col gap-2 ${stale ? "opacity-60" : ""}`}
    >
      <SectionHeader
        id="work-heading"
        label="Working in the background"
        count={loaded ? items.length : null}
        trailing={
          hidden > 0 ? (
            <Link
              href="/projects"
              data-action="work-view-all"
              className="text-[11px] font-semibold leading-[14px] text-[var(--color-accent)] hover:underline"
            >
              View all
            </Link>
          ) : null
        }
      />
      {!loaded ? (
        stale ? (
          <p className="px-3 text-[12px] leading-[16px] text-[var(--color-muted)]">
            Couldn’t check right now — retrying.
          </p>
        ) : (
          <div aria-hidden className="flex flex-col gap-1" data-testid="work-skeleton">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-[52px] animate-pulse rounded-[var(--radius-md)] bg-[var(--color-surface-2)]"
              />
            ))}
          </div>
        )
      ) : shown.length === 0 ? (
        <p
          data-testid="work-empty"
          className="px-3 py-2 text-[12px] font-medium leading-[16px] text-[var(--color-muted)]"
        >
          Nothing is running in the background.
        </p>
      ) : (
        <ul className="flex flex-col" aria-label="Running now">
          {shown.map((item) => (
            <WorkRow key={`${item.kind}:${item.id}`} item={item} now={now} />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The background-work panel fed by the page's one `useActivityRunning` poll
 * (the same read the top bar's running strip renders), so the landing page
 * never polls `/api/activity/running` twice.
 */
export function WorkPanel({
  activity,
  max,
}: {
  activity?: Pick<ActivityRunningState, "items" | "loaded" | "stale">;
  max?: number;
}) {
  return (
    <WorkPanelView
      items={activity?.items ?? []}
      loaded={activity?.loaded ?? false}
      stale={activity?.stale ?? false}
      max={max}
    />
  );
}
