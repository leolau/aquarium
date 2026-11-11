"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { activityLabel, fmtElapsed } from "@/components/ui/useActivityRunning";
import { FolderIcon } from "@/components/ui/icons";
import { useT } from "@/i18n";
import type { ActivityItem, ScheduledSummary } from "@/types";

import { sortWork } from "../work/WorkPanel";
import { KIND_ICON, WORK_STATUS_TONE, workStatus } from "../work/WorkRow";
import { ScheduledButton } from "./ScheduledButton";

/**
 * The desktop running strip under the top bar: "Running N · W waiting", one
 * chip per chat, project run, card or cron job (waiting first, then long
 * runs), ‹ › when the row overflows, and the Scheduled button pinned right.
 * Hidden when nothing runs and nothing is scheduled; "Nothing running right
 * now" beside the button when only scheduled work exists. Stale reads keep
 * the last good chips, dimmed.
 */
export function RunningStripView({
  items,
  now,
  stale = false,
  scheduled = null,
  className = "flex",
}: {
  items: ActivityItem[];
  now: number;
  stale?: boolean;
  scheduled?: ScheduledSummary | null;
  /** Display utility for the root, e.g. `hidden lg:flex`. */
  className?: string;
}) {
  const t = useT("landing");
  const scroller = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
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

  const scheduledTotal = scheduled?.total ?? 0;
  if (items.length === 0 && scheduledTotal === 0) return null;

  const sorted = sortWork(items, now);
  const waiting = items.filter((i) => i.status === "waiting").length;
  const arrow =
    "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)] disabled:invisible";

  return (
    <div
      data-component="RunningStrip"
      data-stale={stale || undefined}
      className={`h-11 items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-bg)] pl-4 pr-3 ${
        stale ? "opacity-60" : ""
      } ${className}`}
    >
      {items.length === 0 ? (
        <p data-testid="running-empty" className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-muted)]">
          {t("running.nothing")}
        </p>
      ) : (
        <>
          <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
            <span aria-hidden className="h-[7px] w-[7px] rounded-full bg-[var(--color-accent)]" />
            {t("running.label")}
            <span data-testid="running-count" className="text-[var(--color-fg)]">
              {items.length}
            </span>
            {waiting ? (
              <span className="normal-case tracking-normal text-[var(--color-warn-text)]">
                · {t("running.waiting", { count: waiting })}
              </span>
            ) : null}
          </span>
          <button
            type="button"
            aria-label={t("running.scrollLeft")}
            data-action="running-scroll-left"
            disabled={!edges.left}
            onClick={() => page(-1)}
            className={arrow}
          >
            <span aria-hidden>‹</span>
          </button>
          <div
            ref={scroller}
            role="list"
            aria-label={t("running.listLabel")}
            onScroll={measure}
            className="flex min-w-0 flex-1 snap-x snap-mandatory items-center gap-2 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {sorted.map((item) => (
              <RunningChip key={`${item.kind}:${item.id}`} item={item} now={now} needsYou={t("running.needsYou")} />
            ))}
          </div>
          <button
            type="button"
            aria-label={t("running.scrollRight")}
            data-action="running-scroll-right"
            disabled={!edges.right}
            onClick={() => page(1)}
            className={arrow}
          >
            <span aria-hidden>›</span>
          </button>
        </>
      )}
      {scheduled ? <ScheduledButton summary={scheduled} now={now} /> : null}
    </div>
  );
}

function RunningChip({ item, now, needsYou }: { item: ActivityItem; now: number; needsYou: string }) {
  const status = workStatus(item, now);
  const tone = WORK_STATUS_TONE[status];
  const Icon = KIND_ICON[item.kind] ?? FolderIcon;
  const elapsed = item.started_at !== null ? fmtElapsed(now - item.started_at * 1000) : null;
  const cls = `inline-flex h-8 max-w-[20rem] shrink-0 snap-start items-center gap-2 whitespace-nowrap rounded-full border pl-2 pr-3 text-[12.5px] ${
    status === "waiting"
      ? "border-[var(--color-warn)] bg-[var(--color-attention-bg)]"
      : "border-[var(--color-border)] bg-[var(--color-surface)]"
  }`;
  const body = (
    <>
      <span aria-hidden data-testid="running-dot" className={`h-[7px] w-[7px] shrink-0 rounded-full ${tone.dot}`} />
      <Icon size={14} className="shrink-0 text-[var(--color-muted)]" />
      <span className="max-w-[14rem] truncate font-medium text-[var(--color-fg)]">{item.name}</span>
      {elapsed !== null ? (
        <span
          data-testid="running-elapsed"
          className={`tabular-nums ${status === "running" ? "text-[var(--color-muted)]" : "text-[var(--color-warn-text)]"}`}
        >
          {status === "waiting" ? `${needsYou} · ` : ""}
          {elapsed}
        </span>
      ) : null}
    </>
  );
  return (
    <span role="listitem" className="contents">
      {item.href ? (
        <Link
          href={item.href}
          title={activityLabel(item)}
          data-status={status}
          className={`${cls} hover:bg-[var(--color-surface-2)]`}
        >
          {body}
        </Link>
      ) : (
        <span title={activityLabel(item)} data-status={status} className={cls}>
          {body}
        </span>
      )}
    </span>
  );
}
