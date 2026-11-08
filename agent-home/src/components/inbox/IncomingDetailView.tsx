"use client";

import Link from "next/link";

import { InfoTip } from "@/components/ui/InfoTip";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { useT } from "@/i18n";
import { ActionButton } from "@/components/ui/ActionButton";
import { useState } from "react";

import { surfaceGlyph } from "@/components/inbox/IncomingRow";
import { surfaceLabel } from "@/components/inbox/IncomingsFilters";
import { formatSize, formatWhen } from "@/components/files/FilesView";
import { AddToProjectSheet } from "@/components/projects/AddToProjectSheet";
import type { IncomingDetail } from "@/types";

/**
 * One arrival in full: its provenance, its text, what it carried, and whether
 * anyone decided to remember it.
 *
 * "Remember" is the only write here, and it is the user's judgement rather
 * than a side effect of arriving — a corpus that ingested every group chat
 * would answer questions with noise.
 */
export function IncomingDetailView({ item }: { item: IncomingDetail }) {
  const [current, setCurrent] = useState(item);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [justRemembered, setJustRemembered] = useState(false);
  const t = useT("inbox");

  async function remember() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/incomings/${encodeURIComponent(current.id)}/remember`,
        { method: "POST" },
      );
      const body = (await res.json()) as IncomingDetail & { detail?: string };
      if (!res.ok) {
        setError(body.detail ?? "It couldn't be remembered.");
        return;
      }
      setCurrent({ ...current, ...body });
      setJustRemembered(true);
    } catch {
      setError("Couldn't reach the AI layer.");
    } finally {
      setBusy(false);
    }
  }

  const title =
    current.subject?.trim() ||
    current.sender_name?.trim() ||
    current.sender_id?.trim() ||
    "(untitled)";

  return (
    <div
      data-component="IncomingDetailView"
      className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start"
    >
      <div className="flex min-w-0 flex-col gap-4">
      <div className="min-w-0 rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <p className="flex items-start gap-2 text-sm font-semibold">
          <span aria-hidden>{surfaceGlyph(current.surface)}</span>
          <span className="min-w-0 break-words">{title}</span>
        </p>

        <dl className="mt-3 grid grid-cols-[112px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs [overflow-wrap:anywhere]">
          <Row label="Arrived">{formatWhen(current.occurred_at)}</Row>
          <Row label="Channel">{surfaceLabel(current.surface)}</Row>
          {current.sender_name || current.sender_id ? (
            <Row label="From">{current.sender_name || current.sender_id}</Row>
          ) : null}
          {current.conversation_name || current.conversation ? (
            <Row label="In">
              {current.conversation_name || current.conversation}
            </Row>
          ) : null}
          {current.ends_at ? (
            <Row label="Until">{formatWhen(current.ends_at)}</Row>
          ) : null}
          {current.importance ? (
            <Row label="Triage">{current.importance}</Row>
          ) : null}
          <Row label="Memory">
            {current.remembered
              ? `Remembered${current.remembered_by ? ` by ${current.remembered_by}` : ""}`
              : "Not in memory"}
          </Row>
        </dl>

        {current.body ? (
          <p className="mt-4 whitespace-pre-wrap break-words text-sm">{current.body}</p>
        ) : null}
      </div>

      {current.attachments.length > 0 ? (
        <div
          data-component="IncomingAttachments"
          className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
        >
          <h2 className="text-xs uppercase tracking-wide text-[var(--color-muted)]">
            Arrived with
          </h2>
          <ul className="mt-2 flex flex-col gap-2 text-sm">
            {current.attachments.map((file) => (
              <li key={file.id} className="flex items-center justify-between gap-3">
                <a
                  href={`/api/files/${encodeURIComponent(file.id)}/content`}
                  target="_blank"
                  rel="noopener"
                  className="truncate text-[var(--color-accent)]"
                >
                  {file.filename}
                </a>
                <span className="shrink-0 text-xs text-[var(--color-muted)]">
                  {formatSize(file.byte_size)}
                </span>
              </li>
            ))}
          </ul>
          <Link
            href="/files"
            className="mt-3 inline-block text-xs text-[var(--color-muted)]"
          >
            All files →
          </Link>
        </div>
      ) : null}

      </div>

      <aside
        data-component="IncomingActions"
        aria-label={t("detail.doSomething")}
        className="sticky bottom-[calc(var(--coral-clearance)+var(--safe-bottom))] z-10 flex flex-col gap-3 rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-lg lg:top-4 lg:bottom-auto lg:shadow-none"
      >
      <h2 className="flex items-center gap-1 text-sm font-semibold">
        {t("detail.doSomething")}
        <InfoTip label={t("detail.rememberInfoLabel")} align="end">
          {t("detail.rememberInfo")}
        </InfoTip>
      </h2>
      {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
      {justRemembered ? <InlineAlert tone="success">{t("detail.remembered")}</InlineAlert> : null}

      <div className="flex flex-wrap gap-2 text-sm lg:flex-col">
        {current.document_id ? (
          <Link
            href={`/memory?document=${encodeURIComponent(current.document_id)}`}
            className="inline-flex min-h-10 items-center justify-center rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2"
          >
            {t("detail.seeRemembered")}
          </Link>
        ) : (
          <ActionButton
            disabled={!current.body}
            busy={busy}
            onAction={remember}
            busyLabel={t("detail.remembering")}
            className="inline-flex min-h-10 items-center justify-center gap-2 rounded-[var(--radius-md)] bg-[var(--color-accent)] px-3 py-2 font-medium text-[var(--color-accent-fg)] disabled:opacity-40"
          >
            {t("detail.rememberThis")}
          </ActionButton>
        )}
        {/* The other direction of the same link the to-do detail page shows:
            an arrival is only half the story once triage acted on it. */}
        <Link
          href={`/todos?source_ref=${encodeURIComponent(current.id)}&stage=staged,open,working,done,dismissed`}
          className="inline-flex min-h-10 items-center justify-center rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2"
        >
          To-dos from this
        </Link>
        {/* "Add to project" (§13): an arrival that belongs to something
            bigger gets linked from the place the user actually is. */}
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          className="inline-flex min-h-10 items-center justify-center rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2"
        >
          Add to project
        </button>
      </div>
      </aside>

      {addOpen ? (
        <AddToProjectSheet
          onClose={() => setAddOpen(false)}
          prefill={{ kind: "arrival", ref: current.id, label: title }}
        />
      ) : null}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt data-component="Row" className="text-[var(--color-muted)]">
        {label}
      </dt>
      <dd className="break-words">{children}</dd>
    </>
  );
}
