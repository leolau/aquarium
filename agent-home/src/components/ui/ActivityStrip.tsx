"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ActivityItem, ActivityRunning } from "@/types";

const POLL_MS = 15_000;
const CLOCK_TICK_MS = 1_000;
/** A run older than this turns amber — worth a look. */
export const LONG_RUN_MS = 30 * 60_000;

const GLYPH: Record<ActivityItem["kind"], string> = {
  chat: "❝",
  project_run: "▶",
  card: "▣",
  cron: "◷",
};

const KIND_LABEL: Record<ActivityItem["kind"], string> = {
  chat: "Chat",
  project_run: "Project run",
  card: "Card",
  cron: "Scheduled job",
};

/** Compact elapsed time: "42s", "12m", "1h 05m", "2d 3h". */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// Last good read, shared across mounts: MobileShell renders per page, so
// every client navigation remounts the bar. A read younger than the poll
// interval is reused instead of re-fetching (same as StatusStrip).
let lastGood: { items: ActivityItem[]; at: number } | null = null;

export function resetActivityStripCache(): void {
  lastGood = null;
}

/**
 * The background-activity bar under the status strip: one chip per chat,
 * project run, card or cron job running right now — kind glyph, name and a
 * locally ticking "running for" time, amber once a run gets long. One row;
 * scrolls sideways (swipe on phones, ‹ › on desktop) when it overflows.
 *
 * Polls while the tab is visible and re-reads on focus; a failed read keeps
 * the last good rows, dimmed. With nothing running it renders nothing at
 * all — no empty row.
 */
export function ActivityStrip() {
  const [items, setItems] = useState<ActivityItem[]>(() => lastGood?.items ?? []);
  const [stale, setStale] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const mounted = useRef(true);
  // One read at a time: the poll and focus wake share it.
  const inFlight = useRef<Promise<void> | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const tick = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    const run = (async () => {
      try {
        const res = await fetch("/api/activity/running", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as ActivityRunning;
        const next = Array.isArray(data.items) ? data.items : [];
        lastGood = { items: next, at: Date.now() };
        if (mounted.current) {
          setItems(next);
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

  useEffect(() => {
    mounted.current = true;
    if (!lastGood || Date.now() - lastGood.at >= POLL_MS) void tick();
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

  const hasItems = items.length > 0;

  // The elapsed timers tick locally — no refetch — and only while there is
  // something to time and the tab is visible.
  useEffect(() => {
    if (!hasItems) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") setNow(Date.now());
    }, CLOCK_TICK_MS);
    return () => clearInterval(t);
  }, [hasItems]);

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
            const elapsedMs =
              item.started_at !== null ? now - item.started_at * 1000 : null;
            const long = elapsedMs !== null && elapsedMs >= LONG_RUN_MS;
            const label = `${KIND_LABEL[item.kind] ?? item.kind}: ${item.name}${
              item.profile ? ` (${item.profile})` : ""
            }${item.status === "waiting" ? " — waiting" : ""}`;
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
