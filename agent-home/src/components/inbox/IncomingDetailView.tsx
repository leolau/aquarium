"use client";

import Link from "next/link";
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
    <div data-component="IncomingDetailView" className="flex flex-col gap-4">
      <Link href="/inbox?tab=incomings" className="text-xs text-[var(--color-muted)]">
        ← Inbox
      </Link>

      <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <h1 className="flex items-start gap-2 text-sm font-semibold">
          <span aria-hidden>{surfaceGlyph(current.surface)}</span>
          <span className="break-words">{title}</span>
        </h1>

        <dl className="mt-3 grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-xs">
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
          <p className="mt-4 whitespace-pre-wrap text-sm">{current.body}</p>
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
                  rel="noreferrer"
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

      {error ? (
        <p className="rounded-lg bg-[var(--color-surface-2)] px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2 text-xs">
        {current.document_id ? (
          <Link
            href={`/memory?document=${encodeURIComponent(current.document_id)}`}
            className="rounded-lg border border-[var(--color-border)] px-3 py-1.5"
          >
            See what it remembers
          </Link>
        ) : (
          <ActionButton
            disabled={!current.body}
            busy={busy}
            onAction={remember}
            busyLabel="Remembering…"
            className="inline-flex items-center gap-2 rounded-lg border border-[var(--color-accent)] px-3 py-1.5 text-[var(--color-accent)] disabled:opacity-40"
          >
            Remember this
          </ActionButton>
        )}
        {/* The other direction of the same link the to-do detail page shows:
            an arrival is only half the story once triage acted on it. */}
        <Link
          href={`/todos?source_ref=${encodeURIComponent(current.id)}&stage=staged,open,working,done,dismissed`}
          className="rounded-lg border border-[var(--color-border)] px-3 py-1.5"
        >
          To-dos from this
        </Link>
        {/* "Add to project" (§13): an arrival that belongs to something
            bigger gets linked from the place the user actually is. */}
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          className="rounded-lg border border-[var(--color-border)] px-3 py-1.5"
        >
          Add to project
        </button>
      </div>

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
