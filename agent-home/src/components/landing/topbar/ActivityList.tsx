"use client";

import Link from "next/link";

import {
  ACTIVITY_GLYPH,
  activityLabel,
  activityTiming,
  fmtElapsed,
} from "@/components/ui/useActivityRunning";
import type { ActivityItem } from "@/types";

/**
 * Everything running right now, one row each: kind glyph, name, profile,
 * Running/Waiting status and a locally ticking elapsed time (amber once a
 * run is long). Rows with a page link to it.
 */
export function ActivityList({ items, now }: { items: ActivityItem[]; now: number }) {
  if (items.length === 0) {
    return (
      <p data-testid="activity-empty" className="px-1 py-1 text-xs text-[var(--color-muted)]">
        Nothing running right now.
      </p>
    );
  }
  return (
    <ul role="list" aria-label="Running now" data-component="ActivityList" className="flex flex-col gap-1">
      {items.map((item) => {
        const { elapsedMs, long } = activityTiming(item, now);
        const waiting = item.status === "waiting";
        const body = (
          <>
            <span aria-hidden className="w-4 shrink-0 text-center text-[var(--color-fg)]">
              {ACTIVITY_GLYPH[item.kind] ?? "•"}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-[var(--color-fg)]">
                {item.name}
              </span>
              {item.profile ? (
                <span className="block truncate text-[11px] text-[var(--color-muted)]">
                  {item.profile}
                </span>
              ) : null}
            </span>
            <span
              data-component="status-pill"
              data-tone={waiting ? "waiting" : "running"}
              className={`inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--color-surface-2)] px-2 py-0.5 text-[11px] font-medium ${
                waiting ? "text-[var(--color-warn)]" : "text-[var(--color-accent)]"
              }`}
            >
              <span
                aria-hidden
                className={`h-1.5 w-1.5 rounded-full ${
                  waiting ? "bg-[var(--color-warn)]" : "bg-[var(--color-accent)]"
                }`}
              />
              {waiting ? "Waiting" : "Running"}
            </span>
            {elapsedMs !== null ? (
              <span
                data-testid="activity-elapsed"
                className={`w-12 shrink-0 text-right text-[11px] tabular-nums ${
                  long ? "font-medium text-[var(--color-warn-text)]" : "text-[var(--color-muted)]"
                }`}
              >
                {fmtElapsed(elapsedMs)}
              </span>
            ) : null}
          </>
        );
        const cls = `flex items-center gap-2 rounded-[var(--radius-md)] px-2 py-1.5 ${
          long ? "bg-[var(--color-attention-bg)]" : ""
        }`;
        return (
          <li key={`${item.kind}:${item.id}`} data-long={long || undefined}>
            {item.href ? (
              <Link
                href={item.href}
                title={activityLabel(item)}
                className={`${cls} hover:bg-[var(--color-surface-2)]`}
              >
                {body}
              </Link>
            ) : (
              <div title={activityLabel(item)} className={cls}>
                {body}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
