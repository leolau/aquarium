"use client";

import { useState } from "react";

import { ActionButton } from "@/components/projects/ActionButton";
import { ActionError } from "@/components/projects/ActionError";
import { useProjectAction } from "@/components/projects/useProjectAction";
import { BusyRegion } from "@/components/ui/BusyRegion";

export const SUMMARY_MAX_CHARS = 4000;

/**
 * Write the project's rolling summary (`POST /{slug}/summarise`). One
 * paragraph that *replaces* the previous one — the header shows it with
 * its `summary_at` freshness. Bottom sheet like {@link EditBriefSheet}.
 */
export function SummariseSheet({
  slug,
  initial,
  onClose,
}: {
  slug: string;
  initial: string;
  /** Called after a successful save too — the caller refreshes. */
  onClose: () => void;
}) {
  const [text, setText] = useState(initial);
  const action = useProjectAction();
  const busy = action.busy;
  const [invalid, setInvalid] = useState<string | null>(null);

  const remaining = SUMMARY_MAX_CHARS - text.length;

  const save = async () => {
    const summary = text.trim();
    if (!summary) {
      setInvalid("Summary needs some text.");
      return;
    }
    if (summary.length > SUMMARY_MAX_CHARS) {
      setInvalid(`Keep the summary under ${SUMMARY_MAX_CHARS} characters.`);
      return;
    }
    setInvalid(null);
    await action.run(`/api/projects/${encodeURIComponent(slug)}/summarise`, {
      body: { summary },
      // The caller refreshes on close and holds its busy state meanwhile.
      skipRefresh: true,
      onSuccess: () => onClose(),
    });
  };
  // Never drop the sheet mid-write: the lock would go with it.
  const close = () => {
    if (!busy) onClose();
  };

  return (
    <div
      data-component="SummariseSheet"
      className="fixed inset-0 z-50 flex items-end bg-black/50"
      onClick={close}
    >
      <div
        role="dialog"
        aria-label="Summarise the project"
        className="mx-auto flex max-h-[90vh] w-full max-w-md flex-col gap-3 overflow-y-auto rounded-t-2xl border-x border-t border-[var(--color-border)] bg-[var(--color-surface)] p-4"
        style={{ paddingBottom: "calc(var(--safe-bottom) + 1rem)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">
            {initial ? "Update the summary" : "Summarise the project"}
          </h2>
          <button
            type="button"
            onClick={close}
            disabled={busy}
            className="rounded-lg px-2 py-1 text-sm text-[var(--color-muted)] disabled:opacity-50"
          >
            Close
          </button>
        </div>
        <p className="text-xs text-[var(--color-muted)]">
          Where the project stands right now, in a paragraph. This replaces
          the previous summary — it is a rolling note, not a log.
        </p>

        <BusyRegion busy={busy} label="Saving…">
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label className="flex flex-col gap-1 text-sm">
              <span className="sr-only">Summary</span>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={7}
                autoFocus
                className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
              />
              <span
                className={`text-right text-xs ${
                  remaining < 0 ? "text-[var(--color-danger)]" : "text-[var(--color-muted)]"
                }`}
              >
                {remaining} left
              </span>
            </label>

            {invalid ? (
              <p role="alert" className="text-sm text-[var(--color-danger)]">
                {invalid}
              </p>
            ) : null}
            <ActionError action={action} className="flex flex-wrap items-center gap-2 text-sm text-[var(--color-danger)]" />

            <div className="flex justify-end">
              <ActionButton
                type="submit"
                busy={busy}
                pendingLabel="Saving…"
                className="rounded-xl bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-50"
              >
                Save summary
              </ActionButton>
            </div>
          </form>
        </BusyRegion>
      </div>
    </div>
  );
}
