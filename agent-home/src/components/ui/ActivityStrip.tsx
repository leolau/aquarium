"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  ACTIVITY_GLYPH as GLYPH,
  LONG_RUN_MS,
  activityLabel,
  activityTiming,
  fmtElapsed,
  resetActivityRunningCache,
  useActivityRunning,
} from "@/components/ui/useActivityRunning";

export { LONG_RUN_MS, fmtElapsed };

export function resetActivityStripCache(): void {
  resetActivityRunningCache();
}

/**
 * The background-activity bar under the status strip: one chip per chat,
 * project run, card or cron job running right now — kind glyph, name and a
 * locally ticking "running for" time, amber once a run gets long. One row;
 * scrolls sideways (swipe on phones, ‹ › on desktop) when it overflows.
 *
 * Data comes from `useActivityRunning` (shared with the landing top bar):
 * polled while visible, re-read on focus; a failed read keeps the last good
 * rows, dimmed. With nothing running it renders nothing at
 * all — no empty row.
 */
export function ActivityStrip() {
  const { items, stale, now } = useActivityRunning();
  const scroller = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const hasItems = items.length > 0;

  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((prev) =>
      prev.left === left && prev.right === right ? prev : { left, right },
    );
  }, []);

  useEffect(() => {
    measure();
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, items]);

  const page = (dir: -1 | 1) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(120, el.clientWidth * 0.8), behavior: "smooth" });
  };

  if (!hasItems) return null;

  const chip =
    "inline-flex shrink-0 snap-start items-center gap-1 whitespace-nowrap rounded-full bg-[var(--color-surface-2)] px-2 py-0.5";
  // Arrows sit in the gutter (negative margin) so the chips line up with
  // the status strip's.
  const arrow =
    "hidden h-5 w-5 shrink-0 items-center justify-center rounded-full hover:bg-[var(--color-surface-2)] hover:text-[var(--color-fg)] disabled:invisible lg:inline-flex";

  return (
    <div
      data-component="ActivityStrip"
      data-stale={stale || undefined}
      className={`border-b border-[var(--color-border)] px-4 py-1.5 text-[11px] text-[var(--color-muted)] lg:px-8 ${
        stale ? "opacity-60" : ""
      }`}
    >
      <div className="mx-auto flex w-full max-w-2xl items-center gap-1 lg:max-w-5xl">
        <button
          type="button"
          aria-label="Scroll activity left"
          data-action="activity-scroll-left"
          disabled={!edges.left}
          onClick={() => page(-1)}
          className={`${arrow} lg:-ml-6`}
        >
          <span aria-hidden>‹</span>
        </button>
        <div
          ref={scroller}
          role="list"
          aria-label="Running now"
          onScroll={measure}
          className="flex min-w-0 flex-1 snap-x snap-mandatory items-center gap-2 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {items.map((item) => {
            const { elapsedMs, long } = activityTiming(item, now);
            const label = activityLabel(item);
            const body = (
              <>
                <span aria-hidden className="text-[var(--color-fg)]">
                  {GLYPH[item.kind] ?? "•"}
                </span>
                <span className="max-w-[14rem] truncate font-medium text-[var(--color-fg)]">
                  {item.name}
                </span>
                {elapsedMs !== null ? (
                  <span
                    data-testid="activity-elapsed"
                    className={long ? "text-[var(--color-warn-text)]" : undefined}
                  >
                    {item.status === "waiting" ? "waiting · " : ""}
                    {fmtElapsed(elapsedMs)}
                  </span>
                ) : null}
              </>
            );
            const cls = `${chip} ${long ? "bg-amber-500/15" : ""}`;
            return (
              <span role="listitem" key={`${item.kind}:${item.id}`} className="contents">
                {item.href ? (
                  <Link href={item.href} className={cls} title={label} data-long={long || undefined}>
                    {body}
                  </Link>
                ) : (
                  <span className={cls} title={label} data-long={long || undefined}>
                    {body}
                  </span>
                )}
              </span>
            );
          })}
        </div>
        <button
          type="button"
          aria-label="Scroll activity right"
          data-action="activity-scroll-right"
          disabled={!edges.right}
          onClick={() => page(1)}
          className={`${arrow} lg:-mr-6`}
        >
          <span aria-hidden>›</span>
        </button>
      </div>
    </div>
  );
}
