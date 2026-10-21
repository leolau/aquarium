"use client";

import { useState } from "react";

import { ActionButton } from "@/components/ui/ActionButton";
import type { TodoCompletion, TodoDetail, TodoProposal } from "@/types";

/**
 * Finishing a to-do, and optionally drafting what should leave because of it.
 *
 * The draft is the outgoing seam's whole user surface, and it is deliberately
 * *not* a send button. What the user writes here becomes an irreversible
 * approval they then answer themselves — so this form ends at "propose", the
 * proposal shows the command it authorises, and nothing has left the building
 * when it closes.
 *
 * The reply route is not offered as fields to fill in. Channel, account and
 * conversation come from the arrival the to-do came from (contract C4: a reply
 * leaves by the account it arrived on), because a free-text "to" box is how a
 * reply ends up in the wrong thread from the wrong address.
 */
export function TodoCompleteForm({
  todo,
  onDone,
}: {
  todo: TodoDetail;
  onDone: (completed: TodoCompletion) => void;
}) {
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState("");
  const [draft, setDraft] = useState("");
  const [subject, setSubject] = useState(todo.source?.subject ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<TodoProposal | null>(null);

  const replyTo = todo.source
    ? todo.source.sender_name ||
      todo.source.sender_id ||
      todo.source.conversation ||
      ""
    : "";

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/todos/${encodeURIComponent(todo.id)}/complete`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            outcome,
            proposed_action: draft.trim()
              ? { body: draft, subject }
              : undefined,
          }),
        },
      );
      const body = (await res.json()) as TodoCompletion & { detail?: string };
      if (!res.ok) {
        setError(body.detail ?? "That didn't stick — try again.");
        return;
      }
      setProposal(body.proposal ?? null);
      setOpen(false);
      onDone(body);
    } catch {
      setError("Couldn't reach the AI layer.");
    } finally {
      setBusy(false);
    }
  }

  if (proposal) {
    return (
      <div
        data-component="TodoCompleteForm"
        className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-xs"
      >
        {proposal.error ? (
          <p className="text-[var(--color-muted)]">
            Marked done, but the reply couldn&apos;t be proposed:{" "}
            {proposal.error}
          </p>
        ) : (
          <>
            <p>
              Marked done. The reply is waiting for your approval — nothing has
              been sent.
            </p>
            {proposal.command ? (
              <code className="mt-2 block break-all rounded-lg bg-[var(--color-surface-2)] px-2 py-1 text-[10px] text-[var(--color-muted)]">
                {proposal.command}
              </code>
            ) : null}
          </>
        )}
      </div>
    );
  }

  if (!open) {
    return (
      <button
        data-component="TodoCompleteForm"
        type="button"
        onClick={() => setOpen(true)}
        className="self-start rounded-lg border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
      >
        Mark done…
      </button>
    );
  }

  return (
    <div
      data-component="TodoCompleteForm"
      className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      <label className="block text-xs text-[var(--color-muted)]">
        What happened
        <input
          value={outcome}
          onChange={(e) => setOutcome(e.target.value)}
          placeholder="Sent the quote"
          className="mt-1 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
        />
      </label>

      {todo.source ? (
        <div className="mt-3">
          <p className="text-xs text-[var(--color-muted)]">
            Propose a reply to {replyTo} on {todo.source.surface}{" "}
            <span className="opacity-70">(optional — you approve it after)</span>
          </p>
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject"
            className="mt-1 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
          />
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={4}
            placeholder="Leave empty to finish without proposing anything."
            className="mt-2 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
          />
        </div>
      ) : null}

      {error ? (
        <p className="mt-2 text-xs text-[var(--color-muted)]">{error}</p>
      ) : null}

      <div className="mt-3 flex gap-2 text-[11px]">
        <ActionButton
          onAction={submit}
          busyLabel="Finishing…"
          className="rounded-lg border border-[var(--color-accent)] px-2 py-1 text-[var(--color-accent)] disabled:opacity-50"
        >
          {draft.trim() ? "Finish and propose" : "Finish"}
        </ActionButton>
        <button
          type="button"
          disabled={busy}
          onClick={() => setOpen(false)}
          className="rounded-lg border border-[var(--color-border)] px-2 py-1 text-[var(--color-muted)]"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
