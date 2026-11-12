"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { ActionButton } from "@/components/ui/ActionButton";
import type { TodoDraft } from "@/types";

/**
 * The draft panel — what the work session produced, reviewed and edited.
 *
 * Both surfaces stay open by design: the draft file is editable inline for
 * the small fixes, and the session link is kept for the changes that are a
 * conversation ("redo the pricing section") rather than an edit.
 */
export function TodoDraftPanel({ todoId }: { todoId: string }) {
  const [draft, setDraft] = useState<TodoDraft | null>(null);
  const [draftText, setDraftText] = useState("");
  const [replyText, setReplyText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/todos/${encodeURIComponent(todoId)}/draft`);
        if (!res.ok) return;
        const payload = (await res.json()) as TodoDraft;
        if (cancelled) return;
        setDraft(payload);
        setDraftText(payload.draft_text ?? "");
        setReplyText(payload.reply_text ?? "");
      } catch {
        /* no draft yet — the panel stays hidden */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [todoId]);

  async function save() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await fetch(`/api/todos/${encodeURIComponent(todoId)}/draft`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ draft_text: draftText, reply_text: replyText }),
      });
      const payload = (await res.json()) as TodoDraft & { detail?: string };
      if (!res.ok) {
        setError(payload.detail ?? "That didn't stick — try again.");
        return;
      }
      setDraft(payload);
      setNote(
        payload.proposal_amended
          ? "Saved — the pending reply now carries your edit."
          : "Saved.",
      );
    } catch {
      setError("Couldn't reach the AI layer.");
    } finally {
      setBusy(false);
    }
  }

  if (!draft) return null;

  const dirty =
    draftText !== (draft.draft_text ?? "") ||
    replyText !== (draft.reply_text ?? "");

  return (
    <div
      data-component="TodoDraftPanel"
      className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xs uppercase tracking-wide text-[var(--color-muted)]">
          Draft for review
        </h2>
        {draft.session_id ? (
          <Link
            href={`/chat?session=${encodeURIComponent(draft.session_id)}`}
            className="text-[11px] text-[var(--color-accent)]"
          >
            Open the session →
          </Link>
        ) : null}
      </div>

      {draft.draft_text !== "" || draft.files?.length ? (
        <label className="mt-3 block text-xs">
          <span className="text-[var(--color-muted)]">The deliverable</span>
          <textarea
            value={draftText}
            onChange={(e) => setDraftText(e.target.value)}
            rows={Math.min(16, Math.max(6, draftText.split("\n").length + 1))}
            className="mt-1 w-full rounded-lg border border-[var(--color-border)] bg-transparent p-2 font-mono text-[11px] leading-relaxed"
          />
        </label>
      ) : null}

      {draft.reply_text !== "" ? (
        <label className="mt-3 block text-xs">
          <span className="text-[var(--color-muted)]">
            The reply — edits here change what "approve" sends
          </span>
          <textarea
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            rows={Math.min(10, Math.max(3, replyText.split("\n").length + 1))}
            className="mt-1 w-full rounded-lg border border-[var(--color-border)] bg-transparent p-2 font-mono text-[11px] leading-relaxed"
          />
        </label>
      ) : null}

      {draft.files && draft.files.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-[var(--color-muted)]">
          {draft.files.map((f) => (
            <li
              key={f.name}
              className="rounded border border-[var(--color-border)] px-1.5 py-0.5"
            >
              {f.name}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-3 flex items-center gap-2">
        <ActionButton
          disabled={busy || !dirty}
          busyLabel="Saving…"
          onAction={() => save()}
          className="rounded-lg border border-[var(--color-accent)] bg-[var(--color-accent)] px-3 py-1.5 text-[11px] font-medium text-[var(--color-surface)] transition hover:opacity-90 disabled:opacity-50"
        >
          Save edits
        </ActionButton>
        {note ? (
          <span className="text-[11px] text-[var(--color-muted)]">{note}</span>
        ) : null}
      </div>

      {error ? (
        <p className="mt-2 text-xs text-[var(--color-muted)]">{error}</p>
      ) : null}
    </div>
  );
}
