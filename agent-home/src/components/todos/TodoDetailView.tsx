"use client";

import Link from "next/link";
import { useState } from "react";

import { surfaceGlyph } from "@/components/inbox/IncomingRow";
import { AddToProjectSheet } from "@/components/projects/AddToProjectSheet";
import { TodoCompleteForm } from "@/components/todos/TodoCompleteForm";
import { ActionButton } from "@/components/ui/ActionButton";
import { useAction } from "@/lib/use-action";
import { STAGE_LABEL, sourceGlyph } from "@/components/todos/TodoRow";
import { formatWhen } from "@/components/files/FilesView";
import type { Todo, TodoDetail, TodoStage } from "@/types";

/** The moves offered from each stage, in the order a user reaches for them. */
const NEXT_STAGES: Record<TodoStage, TodoStage[]> = {
  staged: ["open", "working", "done", "dismissed"],
  open: ["working", "done", "dismissed"],
  working: ["done", "dismissed"],
  done: ["working"],
  dismissed: ["open"],
};

const STAGE_VERB: Record<TodoStage, string> = {
  staged: "Back to staged",
  open: "Open it",
  working: "Work on it",
  done: "Mark done",
  dismissed: "Dismiss",
};

/** Snooze offsets, in hours. "Later" is only useful if it is one tap. */
const SNOOZES: { label: string; hours: number }[] = [
  { label: "3 hours", hours: 3 },
  { label: "Tomorrow", hours: 24 },
  { label: "Next week", hours: 24 * 7 },
];

/**
 * One to-do in full: what it is, where it came from, and everything that has
 * happened to it.
 *
 * The arrival that caused it is quoted inline rather than merely linked. *Why
 * is this here?* is the first question anyone asks of something an agent put
 * in front of them, and answering it a click away is answering it late. When
 * the arrival is gone or was never linked, `source_note` carries the weaker
 * provenance instead — "a WhatsApp message from this number" beats silence.
 */
export function TodoDetailView({ todo }: { todo: TodoDetail }) {
  const [current, setCurrent] = useState<TodoDetail>(todo);
  // One lock for the whole card: while one change is in flight, a click on any
  // other button here is dropped instead of racing it.
  const { run: exclusive, pending: busy } = useAction(
    (work: () => Promise<void>) => work(),
  );
  const [error, setError] = useState<string | null>(null);
  const [sessionLink, setSessionLink] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const post = (path: string, body: unknown) => exclusive(() => postNow(path, body));

  async function postNow(path: string, body: unknown) {
    setError(null);
    try {
      const res = await fetch(
        `/api/todos/${encodeURIComponent(current.id)}${path}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const payload = (await res.json()) as Todo & { detail?: string };
      if (!res.ok) {
        setError(payload.detail ?? "That didn't stick — try again.");
        return;
      }
      setCurrent({ ...current, ...payload });
    } catch {
      setError("Couldn't reach the AI layer.");
    }
  }

  const source = current.source;

  return (
    <div data-component="TodoDetailView" className="flex flex-col gap-4">
      <Link href="/todos" className="text-xs text-[var(--color-muted)]">
        ← To-dos
      </Link>

      <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <h1 className="flex items-start gap-2 text-sm font-semibold">
          <span aria-hidden>{sourceGlyph(current.source_kind)}</span>
          <span className="break-words">{current.title}</span>
        </h1>

        <dl className="mt-3 grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-xs">
          <Row label="Stage">{STAGE_LABEL[current.stage]}</Row>
          <Row label="Priority">{current.priority}</Row>
          {current.due_at ? (
            <Row label="Due">{formatWhen(current.due_at)}</Row>
          ) : null}
          {current.snoozed_until ? (
            <Row label="Snoozed until">{formatWhen(current.snoozed_until)}</Row>
          ) : null}
          <Row label="Raised by">
            {current.origin === "triage" ? "Triage" : current.origin}
          </Row>
          {current.outcome ? (
            <Row label="Outcome">{current.outcome}</Row>
          ) : null}
        </dl>

        {current.description ? (
          <p className="mt-4 whitespace-pre-wrap text-sm">
            {current.description}
          </p>
        ) : null}

        <div className="mt-4 flex flex-wrap gap-1.5 text-[11px]">
          {/* Finishing goes through the form below instead: it is the one
              transition that may also propose something outgoing. */}
          {NEXT_STAGES[current.stage]
            .filter((stage) => stage !== "done")
            .map((stage) => (
              <ActionButton
                key={stage}
                disabled={busy}
                busyLabel="Saving…"
                onAction={() => post("/stage", { stage })}
                className="rounded-lg border border-[var(--color-border)] px-2 py-1 text-[var(--color-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-50"
              >
                {STAGE_VERB[stage]}
              </ActionButton>
            ))}
          {/* "Add to project" (§13): the user is here when they realise the
              to-do belongs to something bigger — link it from both ends. */}
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="rounded-lg border border-[var(--color-border)] px-2 py-1 text-[var(--color-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            Add to project
          </button>
        </div>

        {/* “Work on this” moves to working AND spawns a seeded session.
            The stage change happens first; the spawn is best-effort and
            reports itself.  Sits beside the stage buttons rather than
            replacing “Work on it”, so the user can move the stage without
            spawning if they prefer. */}
        {current.stage === "staged" || current.stage === "open" ? (
          <div className="mt-2">
            <ActionButton
              disabled={busy}
              onAction={() => exclusive(async () => {
                setError(null);
                setSessionLink(null);
                try {
                  const res = await fetch(
                    `/api/todos/${encodeURIComponent(current.id)}/start`,
                    {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ session: true }),
                    },
                  );
                  const payload = (await res.json()) as Todo & {
                    session_id?: string | null;
                    spawned?: boolean;
                    detail?: string;
                  };
                  if (!res.ok) {
                    setError(payload.detail ?? "That didn’t stick — try again.");
                  } else {
                    setCurrent({ ...current, ...payload });
                    if (payload.session_id) {
                      setSessionLink(payload.session_id);
                    }
                  }
                } catch {
                  setError("Couldn’t reach the AI layer.");
                }
              })}
              busyLabel="Starting…"
              className="rounded-lg border border-[var(--color-accent)] bg-[var(--color-accent)] px-3 py-1.5 text-[11px] font-medium text-[var(--color-surface)] transition hover:opacity-90 disabled:opacity-50"
            >
              Work on this
            </ActionButton>
            {sessionLink ? (
              <Link
                href={`/chat?session=${encodeURIComponent(sessionLink)}`}
                className="ml-2 inline-block text-[11px] text-[var(--color-accent)]"
              >
                Session started →
              </Link>
            ) : null}
          </div>
        ) : null}

        {/* Promote to a project card (Part 2). Only a human promotes —
            the card lands in `triage`, not `ready`, and the to-do moves to
            `working`, not `done`. The link-vs-promote difference: link keeps
            it a to-do; promote makes it a card. */}
        {current.stage === "staged" || current.stage === "open" ? (
          <div className="mt-2">
            <ActionButton
              disabled={busy}
              onAction={() => exclusive(async () => {
                const project = window.prompt("Project slug:");
                if (!project) return;
                setError(null);
                try {
                  const res = await fetch(
                    `/api/todos/${encodeURIComponent(current.id)}/promote`,
                    {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ project }),
                    },
                  );
                  const payload = (await res.json()) as Todo & {
                    card_id?: string;
                    project_id?: string;
                    detail?: string;
                  };
                  if (!res.ok) {
                    setError(payload.detail ?? "Promotion failed — try again.");
                  } else {
                    setCurrent({ ...current, ...payload });
                  }
                } catch {
                  setError("Couldn’t reach the AI layer.");
                }
              })}
              busyLabel="Promoting…"
              className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-[11px] text-[var(--color-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-50"
            >
              Promote to a project card
            </ActionButton>
          </div>
        ) : null}

        {current.stage !== "done" && current.stage !== "dismissed" ? (
          <div className="mt-2 flex">
            <TodoCompleteForm
              todo={current}
              onDone={(completed) => setCurrent({ ...current, ...completed })}
            />
          </div>
        ) : null}

        {current.stage === "staged" || current.stage === "open" ? (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--color-muted)]">
            <span>Snooze:</span>
            {SNOOZES.map((option) => (
              <ActionButton
                key={option.hours}
                disabled={busy}
                busyLabel="Snoozing…"
                onAction={() =>
                  post("/snooze", {
                    until: new Date(
                      Date.now() + option.hours * 3_600_000,
                    ).toISOString(),
                  })
                }
                className="rounded-lg border border-[var(--color-border)] px-2 py-1 transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-50"
              >
                {option.label}
              </ActionButton>
            ))}
          </div>
        ) : null}

        {error ? (
          <p className="mt-2 text-xs text-[var(--color-muted)]">{error}</p>
        ) : null}
      </div>

      {source ? (
        <div
          data-component="TodoSource"
          className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
        >
          <h2 className="text-xs uppercase tracking-wide text-[var(--color-muted)]">
            Because of
          </h2>
          <Link
            href={`/inbox/${encodeURIComponent(source.id)}`}
            className="mt-2 flex items-start gap-2 text-sm"
          >
            <span aria-hidden>{surfaceGlyph(source.surface)}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">
                {source.subject?.trim() ||
                  source.sender_name?.trim() ||
                  source.sender_id?.trim() ||
                  "(untitled)"}
              </span>
              <span className="mt-0.5 block text-xs text-[var(--color-muted)]">
                {formatWhen(source.occurred_at)}
              </span>
            </span>
          </Link>
          {source.body ? (
            <blockquote className="mt-2 border-l-2 border-[var(--color-border)] pl-3 text-xs text-[var(--color-muted)]">
              {source.body.slice(0, 400)}
              {source.body.length > 400 ? "…" : ""}
            </blockquote>
          ) : null}
          {/* The memory document the arrival produced, when it has one.
              Absent when the arrival was never remembered — a to-do whose
              provenance is thin renders thin. */}
          {current.memory ? (
            <Link
              href={`/memory?document=${encodeURIComponent(current.memory.id)}`}
              className="mt-2 inline-block text-xs text-[var(--color-muted)]"
            >
              ◇ remembered as{" "}
              <em>{current.memory.title || "untitled"}</em>
            </Link>
          ) : null}
          <Link
            href={`/todos?source_ref=${encodeURIComponent(source.id)}&stage=staged,open,working,done,dismissed`}
            className="mt-3 inline-block text-xs text-[var(--color-muted)]"
          >
            Everything this arrival raised →
          </Link>
        </div>
      ) : current.source_note ? (
        <p
          data-component="TodoSourceNote"
          className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-xs text-[var(--color-muted)]"
        >
          Raised from {current.source_note}. The original message is no longer
          linked.
        </p>
      ) : null}

      {current.history.length > 0 ? (
        <div
          data-component="TodoHistory"
          className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
        >
          <h2 className="text-xs uppercase tracking-wide text-[var(--color-muted)]">
            History
          </h2>
          <ul className="mt-2 flex flex-col gap-1 text-xs text-[var(--color-muted)]">
            {current.history.map((step, index) => (
              <li key={`${step.at}-${index}`} className="flex gap-2">
                <span className="shrink-0">{formatWhen(step.at)}</span>
                <span className="min-w-0 flex-1 break-words">
                  {step.from} → {step.to}
                  {step.actor ? ` · ${step.actor}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {addOpen ? (
        <AddToProjectSheet
          onClose={() => setAddOpen(false)}
          prefill={{ kind: "todo", ref: current.id, label: current.title }}
          promote={{ todoId: current.id, todoTitle: current.title }}
        />
      ) : null}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-[var(--color-muted)]">{label}</dt>
      <dd className="break-words">{children}</dd>
    </>
  );
}
