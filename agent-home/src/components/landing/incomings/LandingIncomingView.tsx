"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { surfaceGlyph, timeRange } from "@/components/inbox/IncomingRow";
import { formatWhen } from "@/components/files/FilesView";
import { AddToProjectSheet } from "@/components/projects/AddToProjectSheet";
import { RefBadge } from "@/components/refs/RefBadge";
import { chatHandOffUrl } from "@/components/landing/startChat";
import { ActionButton } from "@/components/ui/ActionButton";
import { ChevronLeftIcon, CheckIcon, SparklesIcon } from "@/components/ui/icons";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { useT } from "@/i18n";
import {
  incomingPrompt,
  incomingSender,
  incomingTitle,
  incomingsApi,
  isOpenAttention,
  isUrgent,
} from "@/lib/landing/incomings";
import type { IncomingDetail, IncomingItem } from "@/types";

import { reasonLine, surfaceName } from "./reason";

const BUTTON =
  "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[13px] font-medium text-[var(--color-fg)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 lg:min-h-9";

/**
 * One flagged arrival in Home's centre column (plan A.1, mockup screen 1):
 * who, when, why triage flagged it, the text, and what to do about it —
 * Reply with AI (a chat hand-off), Make a to-do, Remember, Add to project,
 * Done (the page shows the Undo toast) and Open in Inbox.
 * `item` is the row that was clicked, so the card paints before the full
 * arrival (body, attachments) is read.
 */
export function LandingIncomingView({
  id,
  item: seed,
  onClose,
  onDone,
}: {
  id: string;
  item?: IncomingItem | null;
  onClose: () => void;
  onDone: (item: IncomingItem) => void;
}) {
  const t = useT("incomings");
  // Mounted with `key={id}`, so nothing here outlives the arrival it shows.
  const [detail, setDetail] = useState<IncomingDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [busy, setBusy] = useState<"todo" | "remember" | null>(null);

  useEffect(() => {
    let alive = true;
    void incomingsApi.detail(id).then((d) => {
      if (!alive) return;
      if (d) setDetail(d);
      else setFailed(true);
    });
    return () => {
      alive = false;
    };
  }, [id]);

  const item: IncomingItem | null = (detail?.id === id ? detail : null) ?? (seed?.id === id ? seed : null);

  if (!item) {
    return (
      <section data-component="LandingIncomingView" className="flex flex-1 flex-col gap-3 p-4 lg:p-8">
        <BackButton onClose={onClose} label={t("actions.back")} />
        {failed ? (
          <InlineAlert tone="danger">{t("errors.detail")}</InlineAlert>
        ) : (
          <p className="text-sm text-[var(--color-muted)]">{t("detail.loading")}</p>
        )}
      </section>
    );
  }

  const title = incomingTitle(item) || "(untitled)";
  const sender = incomingSender(item);
  const urgent = isUrgent(item);
  const open = isOpenAttention(item);
  const when = item.kind === "event" ? timeRange(item) : formatWhen(item.occurred_at);
  const attachments = detail?.attachments.length ?? 0;

  async function makeTodo() {
    if (!item) return;
    setBusy("todo");
    setError(null);
    const res = await incomingsApi.createTodo(item, title);
    setBusy(null);
    if (res.ok) setNote(t("toast.todo", { ref: res.data.ref || item.ref || item.id }));
    else setError(res.error || t("errors.write"));
  }

  async function remember() {
    if (!item) return;
    setBusy("remember");
    setError(null);
    const res = await incomingsApi.remember(item.id);
    setBusy(null);
    if (res.ok) {
      setDetail((d) => (d ? { ...d, ...res.data } : d));
      setNote(t("toast.remembered"));
    } else {
      setError(res.error || t("errors.write"));
    }
  }

  return (
    <section
      data-component="LandingIncomingView"
      aria-labelledby="landing-incoming-title"
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4 lg:px-8 lg:py-6"
    >
      <div className="flex items-center gap-2">
        <BackButton onClose={onClose} label={t("actions.back")} />
        <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">
          {t("detail.label")}
        </span>
      </div>

      <article className="mx-auto flex w-full max-w-2xl flex-col gap-3 rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 lg:p-5">
        <header className="flex items-start gap-3">
          <span
            aria-hidden
            className="grid size-9 shrink-0 place-items-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)]"
          >
            {surfaceGlyph(item.surface)}
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="landing-incoming-title" className="break-words text-base font-semibold leading-6">
              {title}
            </h2>
            <p className="text-xs text-[var(--color-muted)]">
              {[sender && sender !== title ? sender : "", surfaceName(item.surface, t), when]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
          <span
            data-slot="attention-state"
            className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
              !open
                ? "bg-[var(--color-surface-2)] text-[var(--color-muted)]"
                : urgent
                  ? "bg-[var(--color-danger)] text-white"
                  : "bg-[var(--color-warn)] text-[var(--color-bg)]"
            }`}
          >
            {!open
              ? t("detail.handled")
              : urgent
                ? t("detail.tagUrgent")
                : t("detail.tagNeedsLook")}
          </span>
        </header>

        <p
          data-slot="reason"
          className="flex items-start gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-xs text-[var(--color-warn-text)]"
        >
          <span aria-hidden>⚑</span>
          <span>
            <span className="font-semibold">{t("detail.why")}</span> {reasonLine(item, t)}
          </span>
        </p>

        {item.body ? (
          <p className="whitespace-pre-wrap break-words text-sm leading-6">{item.body}</p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-muted)]">
          <RefBadge value={item.ref} />
          {attachments ? (
            <span>
              📎 {attachments === 1 ? t("detail.attachment") : t("detail.attachments", { count: attachments })}
            </span>
          ) : null}
        </div>

        {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
        {note ? <InlineAlert tone="success">{note}</InlineAlert> : null}

        <div data-component="LandingIncomingActions" className="flex flex-wrap gap-2 pt-1">
          <Link
            href={chatHandOffUrl(incomingPrompt(item, "reply"))}
            data-action="incoming-reply"
            className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--color-accent)] px-3 text-[13px] font-medium text-[var(--color-accent-fg)] lg:min-h-9"
          >
            <SparklesIcon size={14} />
            {t("actions.replyWithAi")}
          </Link>
          <ActionButton
            busy={busy === "todo"}
            onAction={makeTodo}
            busyLabel={t("actions.makingTodo")}
            data-action="incoming-todo"
            className={BUTTON}
          >
            {t("actions.makeTodo")}
          </ActionButton>
          {detail?.document_id || item.remembered ? (
            <Link
              href={detail?.document_id ? `/memory?document=${encodeURIComponent(detail.document_id)}` : "/memory"}
              className={BUTTON}
            >
              {t("actions.seeRemembered")}
            </Link>
          ) : (
            <ActionButton
              busy={busy === "remember"}
              onAction={remember}
              busyLabel={t("actions.remembering")}
              disabled={!item.body}
              data-action="incoming-remember"
              className={BUTTON}
            >
              {t("actions.remember")}
            </ActionButton>
          )}
          <button type="button" data-action="incoming-add-to-project" onClick={() => setAddOpen(true)} className={BUTTON}>
            {t("actions.addToProject")}
          </button>
          {open ? (
            <button
              type="button"
              data-action="incoming-done"
              onClick={() => onDone(item)}
              className={BUTTON}
            >
              <CheckIcon size={14} />
              {t("actions.done")}
            </button>
          ) : null}
          <Link
            href={`/inbox/${encodeURIComponent(item.id)}`}
            data-action="incoming-open-inbox"
            className={`${BUTTON} lg:ml-auto`}
          >
            {t("actions.openInInbox")} →
          </Link>
        </div>
        <p className="text-[11px] text-[var(--color-muted)]">{t("detail.footnote")}</p>
      </article>

      {addOpen ? (
        <AddToProjectSheet
          onClose={() => setAddOpen(false)}
          prefill={{ kind: "arrival", ref: item.id, label: title }}
        />
      ) : null}
    </section>
  );
}

function BackButton({ onClose, label }: { onClose: () => void; label: string }) {
  return (
    <button
      type="button"
      data-action="close-incoming"
      onClick={onClose}
      className="inline-flex min-h-11 items-center gap-1 rounded-[var(--radius-md)] px-2 text-[13px] text-[var(--color-muted)] hover:text-[var(--color-fg)] lg:min-h-8"
    >
      <ChevronLeftIcon size={14} />
      {label}
    </button>
  );
}
