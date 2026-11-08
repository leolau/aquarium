"use client";

import { ActionButton } from "@/components/projects/ActionButton";
import type { ProjectAction } from "@/components/projects/useProjectAction";

/** A failed action's sentence plus Retry (same idempotency key). */
export function ActionError<T>({ action }: { action: ProjectAction<T> }) {
  if (!action.error || action.busy) return null;
  return (
    <p role="alert" className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--color-danger)]">
      {action.error}
      <ActionButton
        busy={action.busy}
        pendingLabel="Retrying…"
        onClick={() => void action.retry()}
        className="rounded-lg border border-red-300/40 px-2 py-0.5 text-xs disabled:opacity-50"
      >
        Retry
      </ActionButton>
    </p>
  );
}
