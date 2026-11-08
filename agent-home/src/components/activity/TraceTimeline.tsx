"use client";

import Link from "next/link";

import { InlineAlert } from "@/components/ui/InlineAlert";
import { ChevronRightIcon, ClockIcon } from "@/components/ui/icons";
import { Pill } from "@/components/ui/Pill";
import { useT } from "@/i18n/client";
import type { TraceSummary } from "@/types";

/**
 * FG-20 Wave B2 — interaction-trace list (read-only, C8).
 *
 * Lists the C2-scoped C8 traces the Python ledger returns from
 * `/api/comms/traces`: one row per conversation/trace with its platform,
 * event count, per-kind breakdown, and span. Tapping a row opens its
 * event-level timeline at `/activity/{trace_id}`. The channel filter lives in
 * the URL (`?channel=`) so it survives reloads and Back.
 */

function fmt(ts: string | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}

function filterHref(channel: string | null): string {
  return channel ? `/activity?channel=${encodeURIComponent(channel)}` : "/activity";
}

export function TraceTimeline({
  traces,
  configured,
  channel = null,
}: {
  traces: TraceSummary[];
  configured: boolean;
  /** Selected channel filter, from `?channel=`. */
  channel?: string | null;
}) {
  const t = useT("settings");
  if (!configured) {
    return (
      <div data-component="TraceTimeline" data-state="not-configured">
        <InlineAlert tone="info">
          {t("activity.notConfigured")} {t("activity.askOwner")}
        </InlineAlert>
      </div>
    );
  }

  if (traces.length === 0) {
    return (
      <div
        data-component="TraceTimeline"
        data-state="empty"
        className="mx-auto flex max-w-md flex-col items-center gap-2 rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-8 text-center"
      >
        <ClockIcon size={24} aria-hidden className="text-[var(--color-muted)]" />
        <p className="text-base font-semibold">{t("activity.empty.title")}</p>
        <p className="text-sm text-[var(--color-muted)]">{t("activity.empty.body")}</p>
      </div>
    );
  }

  const channels = [...new Set(traces.map((tr) => tr.platform).filter((p): p is string => !!p))].sort();
  const shown = channel ? traces.filter((tr) => tr.platform === channel) : traces;
  const chip = (active: boolean) =>
    `inline-flex min-h-9 items-center rounded-[var(--radius-full)] border px-3 text-sm ${
      active
        ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
        : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-fg)]"
    }`;

  return (
    <div data-component="TraceTimeline" className="flex flex-col gap-4">
      {channels.length > 1 ? (
        <nav aria-label={t("activity.filter.label")} className="flex flex-wrap gap-2">
          <Link href={filterHref(null)} aria-current={channel ? undefined : "page"} className={chip(!channel)}>
            {t("activity.filter.all")}
          </Link>
          {channels.map((c) => (
            <Link key={c} href={filterHref(c)} aria-current={channel === c ? "page" : undefined} className={chip(channel === c)}>
              {c}
            </Link>
          ))}
        </nav>
      ) : null}
      {shown.length === 0 ? (
        <InlineAlert tone="info">{t("activity.filter.empty")}</InlineAlert>
      ) : (
        <ul className="grid grid-cols-1 gap-2 lg:grid-cols-2 lg:gap-3">
          {shown.map((trace) => (
            <li key={trace.trace_id}>
              <Link
                href={`/activity/${encodeURIComponent(trace.trace_id)}`}
                data-component="TraceCard"
                className="flex h-full items-start gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 active:bg-[var(--color-surface-2)]"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {trace.platform ? <Pill tone="accent">{trace.platform}</Pill> : null}
                    <Pill tone="muted">{t("activity.events", { count: trace.event_count })}</Pill>
                    {trace.rolled_up ? <Pill tone="muted">{t("activity.rolledUp")}</Pill> : null}
                    {trace.actor_user_id ? (
                      <span className="break-all text-xs text-[var(--color-muted)]">
                        {t("activity.by", { who: trace.actor_user_id })}
                      </span>
                    ) : null}
                  </div>
                  {Object.keys(trace.kind_counts).length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {Object.entries(trace.kind_counts).map(([kind, n]) => (
                        <span
                          key={kind}
                          className="rounded-[var(--radius-full)] bg-[var(--color-surface-2)] px-2 py-0.5 text-xs text-[var(--color-muted)]"
                        >
                          {kind} · {n}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  <p className="mt-2 text-xs text-[var(--color-muted)]">{fmt(trace.last_ts)}</p>
                </div>
                <ChevronRightIcon size={16} aria-hidden className="mt-1 shrink-0 text-[var(--color-muted)]" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
