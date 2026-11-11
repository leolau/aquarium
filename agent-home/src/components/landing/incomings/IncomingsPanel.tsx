"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { ArrowRightIcon } from "@/components/ui/icons";
import { useT } from "@/i18n";
import {
  incomingSender,
  isUrgent,
  surfaceGroup,
  type IncomingsFilter,
  type UseIncomings,
} from "@/lib/landing/incomings";
import type { IncomingItem } from "@/types";

import { IncomingCompactRow } from "./IncomingCompactRow";

const FILTERS: IncomingsFilter[] = ["all", "messages", "email", "calendar"];

function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <h3 className="flex items-center gap-2 px-2 pb-1 pt-3 text-[11px] font-semibold uppercase leading-[14px] tracking-wide text-[var(--color-muted)]">
      {label}
      <span>{count}</span>
    </h3>
  );
}

function SkeletonRows() {
  return (
    <ul aria-hidden="true" className="flex flex-col gap-1 pt-2">
      {[0, 1, 2].map((i) => (
        <li key={i} className="grid grid-cols-[28px_1fr] gap-2 px-2 py-2">
          <span className="size-7 rounded-full bg-[var(--color-surface-2)] motion-safe:animate-pulse" />
          <span className="flex flex-col gap-1.5">
            <span className="h-3.5 w-2/3 rounded-[var(--radius-sm)] bg-[var(--color-surface-2)] motion-safe:animate-pulse" />
            <span className="h-3 w-5/6 rounded-[var(--radius-sm)] bg-[var(--color-surface-2)] motion-safe:animate-pulse" />
          </span>
        </li>
      ))}
    </ul>
  );
}

function matches(item: IncomingItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [incomingSender(item), item.subject, item.body, item.ref, item.conversation_name]
    .filter(Boolean)
    .some((v) => String(v).toLowerCase().includes(q));
}

/**
 * The landing Incomings tab (plan A.1, mockup screen 1): arrivals triage
 * flagged as needing the user and nobody has marked done yet, grouped
 * Urgent / Needs a look, with channel chips and a footer into the Inbox.
 * The list state lives in `useIncomings` (owned by the page) so the
 * sidebar, the phone drawer and the centre detail never disagree.
 */
export function IncomingsPanel({
  incomings,
  query = "",
  activeId = null,
  busyIds,
  onOpen,
  onDone,
  onNavigate,
}: {
  incomings: UseIncomings;
  /** The panel's search box (filters the loaded rows). */
  query?: string;
  activeId?: string | null;
  busyIds?: ReadonlySet<string>;
  /** Open a row in place (desktop Home); without it rows link to `/inbox/{id}`. */
  onOpen?: (item: IncomingItem) => void;
  onDone: (item: IncomingItem) => void;
  onNavigate?: () => void;
}) {
  const t = useT("incomings");
  const [filter, setFilter] = useState<IncomingsFilter>("all");
  const searched = useMemo(
    () => incomings.items.filter((i) => matches(i, query)),
    [incomings.items, query],
  );
  const counts = useMemo(() => {
    const c: Record<IncomingsFilter, number> = { all: 0, messages: 0, email: 0, calendar: 0 };
    for (const i of searched) {
      c.all += 1;
      c[surfaceGroup(i.surface)] += 1;
    }
    return c;
  }, [searched]);
  const rows = searched.filter((i) => filter === "all" || surfaceGroup(i.surface) === filter);
  const urgent = rows.filter(isUrgent);
  const rest = rows.filter((i) => !isUrgent(i));
  const total = incomings.items.length;

  const row = (item: IncomingItem) => (
    <IncomingCompactRow
      key={item.id}
      item={item}
      active={item.id === activeId}
      busy={busyIds?.has(item.id)}
      onOpen={onOpen}
      onDone={onDone}
      onNavigate={onNavigate}
    />
  );

  return (
    <div
      data-component="IncomingsPanel"
      role="tabpanel"
      aria-label={t("tabs.incomings")}
      className="flex min-h-0 flex-1 flex-col gap-2"
    >
      {total > 0 ? (
        <div
          role="group"
          aria-label={t("filters.label")}
          data-component="IncomingsFilterChips"
          className="flex flex-wrap gap-1"
        >
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              data-action="filter-incomings"
              data-filter={f}
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              className={`inline-flex min-h-11 items-center gap-1 rounded-full border px-2 text-xs lg:min-h-7 ${
                filter === f
                  ? "border-[var(--color-accent)] bg-[var(--color-surface-2)] font-medium text-[var(--color-fg)]"
                  : "border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-fg)]"
              }`}
            >
              {t(`filters.${f}`)}{" "}
              <span className="tabular-nums opacity-70">{counts[f]}</span>
            </button>
          ))}
        </div>
      ) : null}

      <nav
        aria-label={t("tabs.incomings")}
        className="-mx-1 flex min-h-0 flex-1 flex-col overflow-y-auto px-1"
      >
        {incomings.loading ? (
          <SkeletonRows />
        ) : incomings.failed ? (
          <p role="alert" data-component="IncomingsError" className="px-2 py-2 text-xs text-[var(--color-muted)]">
            {t("errors.load")}{" "}
            <button type="button" onClick={() => void incomings.refresh()} className="underline">
              {t("errors.retry")}
            </button>
          </p>
        ) : total === 0 ? (
          <div
            data-component="IncomingsEmpty"
            data-reason={incomings.noSources ? "no-sources" : "all-clear"}
            className="mx-1 mt-4 rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border)] px-4 py-5 text-center"
          >
            <p className="text-[13px] font-medium text-[var(--color-fg)]">
              {incomings.noSources ? t("empty.noSourcesTitle") : t("empty.title")}
            </p>
            <p className="mt-1 text-xs text-[var(--color-muted)]">
              {incomings.noSources ? t("empty.noSources") : t("empty.body")}
            </p>
          </div>
        ) : rows.length === 0 ? (
          <p className="px-2 py-3 text-xs text-[var(--color-muted)]">
            {query.trim() ? t("empty.search", { query: query.trim() }) : t("empty.filtered")}
          </p>
        ) : (
          <>
            {urgent.length ? (
              <section aria-label={t("groups.urgent")} className="flex flex-col">
                <SectionHeader label={t("groups.urgent")} count={urgent.length} />
                <ul className="flex flex-col gap-0.5">{urgent.map(row)}</ul>
              </section>
            ) : null}
            {rest.length ? (
              <section aria-label={t("groups.needsLook")} className="flex flex-col">
                <SectionHeader label={t("groups.needsLook")} count={rest.length} />
                <ul className="flex flex-col gap-0.5">{rest.map(row)}</ul>
              </section>
            ) : null}
          </>
        )}
      </nav>

      <Link
        href="/inbox"
        onClick={onNavigate}
        data-component="OpenInboxButton"
        className="mt-auto inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[13px] font-medium leading-[18px] text-[var(--color-fg)] hover:bg-[var(--color-surface-2)] lg:min-h-0"
      >
        <span aria-hidden>✉</span>
        {t("openInbox")}
        <ArrowRightIcon size={14} className="text-[var(--color-muted)]" />
      </Link>
    </div>
  );
}
