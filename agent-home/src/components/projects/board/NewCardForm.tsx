"use client";

import { useState } from "react";

import { ActionButton } from "@/components/projects/ActionButton";
import type { BoardUpdate } from "@/components/projects/board/NeedsYouCard";
import { reconcileTask } from "@/components/projects/board/model";
import { newBoardCard } from "@/components/projects/cardMoves";
import { useProjectAction } from "@/components/projects/useProjectAction";

/** "+ New card": a title, created in triage (a person approves it next). */
export function NewCardForm({
  slug,
  update,
  onDone,
}: {
  slug: string;
  update: BoardUpdate;
  onDone: () => void;
}) {
  const action = useProjectAction<{ task_id?: string; status?: string }>();
  const [title, setTitle] = useState("");
  const [invalid, setInvalid] = useState(false);

  const create = async () => {
    const t = title.trim();
    if (!t) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    const result = await action.run(`/api/projects/${encodeURIComponent(slug)}/cards`, {
      method: "POST",
      body: { title: t },
      onSuccess: (data) => {
        if (typeof data.task_id === "string") {
          const id = data.task_id;
          update((b) => reconcileTask(b, newBoardCard(id, t, data.status || "triage")));
        }
      },
    });
    if (result?.ok) {
      setTitle("");
      onDone();
    }
  };

  return (
    <form
      data-component="BoardNewCard"
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
      className="flex flex-col gap-1.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-2"
    >
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        disabled={action.busy}
        placeholder="What needs doing?"
        aria-label="New card title"
        className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
      />
      <div className="flex items-center gap-1.5">
        <p className="flex-1 text-xs text-[var(--color-muted)]">
          New cards wait in Needs you until someone approves them.
        </p>
        <button
          type="button"
          onClick={onDone}
          className="rounded-lg px-2 py-1 text-xs text-[var(--color-muted)]"
        >
          Cancel
        </button>
        <ActionButton
          type="submit"
          busy={action.busy}
          pendingLabel="Creating…"
          className="rounded-lg bg-[var(--color-accent)] px-2.5 py-1 text-xs font-medium text-[var(--color-accent-fg)] disabled:opacity-50"
        >
          Create
        </ActionButton>
      </div>
      {invalid ? (
        <p role="alert" className="text-xs text-[var(--color-danger)]">
          A card needs a title.
        </p>
      ) : null}
      {action.error ? (
        <div role="alert" className="flex items-center gap-2 text-xs text-[var(--color-danger)]">
          <span>Couldn&rsquo;t create the card: {action.error}</span>
          <ActionButton
            busy={action.busy}
            pendingLabel="Retrying…"
            onClick={async () => {
              const result = await action.retry();
              if (result?.ok) {
                setTitle("");
                onDone();
              }
            }}
            className="rounded-md border border-red-400/50 px-2 py-0.5 text-xs"
          >
            Retry
          </ActionButton>
        </div>
      ) : null}
    </form>
  );
}
