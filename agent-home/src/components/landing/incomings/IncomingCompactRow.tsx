"use client";

import Link from "next/link";

import { excerpt, relativeWhen, surfaceGlyph, timeRange } from "@/components/inbox/IncomingRow";
import { RefBadge } from "@/components/refs/RefBadge";
import { CheckIcon, SparklesIcon } from "@/components/ui/icons";
import { useT } from "@/i18n";
import { chatHandOffUrl } from "@/components/landing/startChat";
import { incomingPrompt, incomingSender, incomingTitle, isUrgent } from "@/lib/landing/incomings";
import type { IncomingItem } from "@/types";

import { reasonLine } from "./reason";

/** Row actions take no room until hovered or focused (always shown on touch). */
const revealOnHover = "hidden group-hover:flex group-focus-within:flex [@media(hover:none)]:flex";

/** Where a row goes when it is not opened in place: the arrival's own page. */
export function incomingHref(id: string): string {
  return `/inbox/${encodeURIComponent(id)}?from=landing`;
}

/**
 * One flagged arrival in the landing Incomings tab: channel glyph, sender,
 * time, subject or excerpt, and the triage reason line. Done and Ask in chat
 * sit on hover (always visible on touch). A plain click opens it in place
 * via `onOpen` (desktop Home); otherwise, and for modified clicks, the link
 * opens `/inbox/{id}?from=landing`.
 */
export function IncomingCompactRow({
  item,
  active = false,
  busy = false,
  onOpen,
  onDone,
  onNavigate,
}: {
  item: IncomingItem;
  active?: boolean;
  busy?: boolean;
  onOpen?: (item: IncomingItem) => void;
  onDone?: (item: IncomingItem) => void;
  onNavigate?: () => void;
}) {
  const t = useT("incomings");
  const sender = incomingSender(item) || incomingTitle(item) || "(untitled)";
  const line =
    (item.subject?.trim() && item.subject.trim() !== sender ? item.subject.trim() : "") ||
    (item.kind === "event" ? timeRange(item) : "") ||
    excerpt(item, 120);
  const urgent = isUrgent(item);
  const title = incomingTitle(item) || sender;

  return (
    <li
      data-component="IncomingCompactRow"
      data-urgent={urgent || undefined}
      data-state={active ? "active" : "default"}
      className={`group relative grid grid-cols-[28px_minmax(0,1fr)] gap-2 rounded-[var(--radius-lg)] border px-2 py-2 transition-colors ${
        active
          ? "border-[var(--color-accent)] bg-[var(--color-surface)]"
          : "border-transparent hover:bg-[var(--color-surface-2)] focus-within:bg-[var(--color-surface-2)]"
      }`}
    >
      <span
        aria-hidden
        className="grid size-7 place-items-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[13px]"
      >
        {surfaceGlyph(item.surface)}
      </span>
      <div className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          {urgent ? (
            <span
              data-slot="urgent-dot"
              role="img"
              aria-label={t("urgentDot")}
              className="size-1.5 shrink-0 rounded-full bg-[var(--color-danger)]"
            />
          ) : null}
          <Link
            href={incomingHref(item.id)}
            aria-current={active ? "true" : undefined}
            onClick={(e) => {
              if (onOpen && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && e.button === 0) {
                e.preventDefault();
                onOpen(item);
              }
              onNavigate?.();
            }}
            className="min-w-0 truncate text-[13px] font-semibold leading-[18px] text-[var(--color-fg)] outline-none after:absolute after:inset-0 after:rounded-[var(--radius-lg)] focus-visible:after:ring-2 focus-visible:after:ring-[var(--color-accent)]"
          >
            {sender}
          </Link>
          {item.has_attachments ? (
            <span title={t("hasAttachment")} className="shrink-0 text-[11px] text-[var(--color-muted)]">
              📎<span className="sr-only">{t("hasAttachment")}</span>
            </span>
          ) : null}
          <span className="ml-auto shrink-0 text-[11px] tabular-nums text-[var(--color-muted)]">
            {relativeWhen(item.occurred_at)}
          </span>
        </span>
        {line ? (
          <span className="mt-px truncate text-xs leading-4 text-[var(--color-fg)] opacity-90">{line}</span>
        ) : null}
        <span
          data-slot="reason"
          className="mt-0.5 flex min-w-0 items-start gap-1 text-[11px] leading-[15px] text-[var(--color-warn-text)]"
        >
          <span aria-hidden>⚑</span>
          <span className="min-w-0 flex-1 truncate">{reasonLine(item, t)}</span>
          <RefBadge value={item.ref} className="relative z-10 lg:!min-h-0" />
        </span>
      </div>
      <span
        data-slot="row-actions"
        className={`absolute right-1.5 top-1.5 z-10 gap-0.5 [@media(hover:none)]:static [@media(hover:none)]:col-start-2 [@media(hover:none)]:w-fit rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5 shadow-sm ${revealOnHover}`}
      >
        {onDone ? (
          <button
            type="button"
            data-action="incoming-done"
            disabled={busy}
            onClick={() => onDone(item)}
            aria-label={t("actions.doneLabel", { title })}
            className="inline-flex min-h-11 items-center gap-1 rounded-[var(--radius-sm)] px-2 text-[11px] text-[var(--color-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-fg)] disabled:opacity-50 lg:min-h-6"
          >
            <CheckIcon size={12} />
            {t("actions.done")}
          </button>
        ) : null}
        <Link
          href={chatHandOffUrl(incomingPrompt(item, "ask"))}
          data-action="incoming-ask"
          onClick={onNavigate}
          aria-label={t("actions.askLabel", { title })}
          className="inline-flex min-h-11 items-center gap-1 rounded-[var(--radius-sm)] px-2 text-[11px] text-[var(--color-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-fg)] lg:min-h-6"
        >
          <SparklesIcon size={12} />
          {t("actions.askInChat")}
        </Link>
      </span>
    </li>
  );
}
