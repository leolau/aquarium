"use client";

import { useEffect, useState } from "react";

import { InlineAlert } from "@/components/ui/InlineAlert";
import { CheckIcon } from "@/components/ui/icons";
import { Pill } from "@/components/ui/Pill";
import type { Tone } from "@/components/ui/Pill";
import { useT } from "@/i18n/client";
import type { TraceDetailResponse, TraceRow } from "@/types";

/**
 * FG-20 Wave B2 — one C8 trace's event-level timeline (read-only, C2-scoped).
 *
 * Renders the ordered interaction events the Python ledger returns from
 * `/api/comms/traces/{id}`: each `inbound`/`turn`/`tool_call`/`tool_result`/
 * `outbound`/`error`/… step with its kind, ref, and summary. Nested tool events
 * are indented under their parent turn. The "About" rail sits beside the
 * timeline on desktop and above it on phones. Back to Activity is the shell's.
 */

const KIND_TONE: Record<string, Tone> = {
  inbound: "accent",
  turn: "muted",
  tool_call: "muted",
  tool_result: "muted",
  outbound: "success",
  approval: "warning",
  change: "warning",
  cost: "muted",
  error: "danger",
  core_denied: "danger",
};

function fmt(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleTimeString();
}

function EventRow({ event }: { event: TraceRow }) {
  const nested = event.kind === "tool_call" || event.kind === "tool_result";
  return (
    <li data-component="TraceEventRow" className={nested ? "pl-4 md:pl-8" : ""}>
      <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone={KIND_TONE[event.kind] ?? "muted"}>{event.kind}</Pill>
          <span className="text-xs text-[var(--color-muted)]">{fmt(event.ts)}</span>
        </div>
        {event.summary ? <p className="mt-1 break-words text-sm">{event.summary}</p> : null}
        {event.ref ? (
          <code className="mt-1 block break-all text-xs text-[var(--color-muted)]">{event.ref}</code>
        ) : null}
      </div>
    </li>
  );
}

function CopyTraceId({ id }: { id: string }) {
  const t = useT("settings");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      data-action="copy-trace-id"
      onClick={() => {
        void navigator.clipboard?.writeText(id).then(() => setCopied(true));
      }}
      className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 text-sm font-semibold"
    >
      {copied ? <CheckIcon size={16} aria-hidden className="text-[var(--color-success)]" /> : null}
      <span role="status">{copied ? t("trace.copied") : t("trace.copy")}</span>
    </button>
  );
}

export function TraceDetail({ detail }: { detail: TraceDetailResponse }) {
  const t = useT("settings");
  if (!detail.configured) {
    return (
      <div data-component="TraceDetail" data-state="not-configured">
        <InlineAlert tone="info">
          {t("activity.notConfigured")} {t("activity.askOwner")}
        </InlineAlert>
      </div>
    );
  }

  const { rollup, interactions } = detail;

  return (
    <div data-component="TraceDetail" className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
      <aside className="flex flex-col gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 lg:order-2">
        <h2 className="text-sm font-semibold">{t("trace.about")}</h2>
        <dl className="flex flex-col gap-2 text-sm">
          <div>
            <dt className="text-xs text-[var(--color-muted)]">{t("trace.id")}</dt>
            <dd>
              <code className="block break-all">{detail.trace_id}</code>
            </dd>
          </div>
          {rollup ? (
            <>
              {rollup.platform ? (
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <dt className="text-[var(--color-muted)]">{t("trace.channel")}</dt>
                  <dd>
                    <Pill tone="accent">{rollup.platform}</Pill>
                  </dd>
                </div>
              ) : null}
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <dt className="text-[var(--color-muted)]">{t("trace.events")}</dt>
                <dd>{t("activity.events", { count: rollup.event_count })}</dd>
              </div>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <dt className="text-[var(--color-muted)]">{t("trace.mode")}</dt>
                <dd>{rollup.mode}</dd>
              </div>
            </>
          ) : null}
        </dl>
        <CopyTraceId id={detail.trace_id} />
        <p className="text-xs text-[var(--color-muted)]">{t("trace.readOnly")}</p>
      </aside>

      <section className="min-w-0 lg:order-1">
        {interactions.length === 0 ? (
          <InlineAlert tone="info">{t("trace.noEvents")}</InlineAlert>
        ) : (
          <ol className="flex flex-col gap-2">
            {interactions.map((event) => (
              <EventRow key={event.id} event={event} />
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
