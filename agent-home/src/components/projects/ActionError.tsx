"use client";

import { ActionButton } from "@/components/projects/ActionButton";

/**
 * The failed state of a `useProjectAction` button: what went wrong, and a
 * Retry that re-sends the *same* idempotency key — so if the first attempt
 * did land server-side, the retry replays it instead of acting twice.
 */
export function ActionError({
  action,
  className,
}: {
  action: {
    error: string | null;
    busy: boolean;
    retry: () => Promise<unknown>;
  };
  className?: string;
}) {
  if (!action.error) return null;
  return (
    <div
      data-component="ActionError"
      className={
        className ?? "mt-2 flex flex-wrap items-center gap-2 text-sm text-[var(--color-danger)]"
      }
    >
      <span role="alert" className="min-w-0 flex-1">
        {action.error}
      </span>
      <ActionButton
        busy={action.busy}
        pendingLabel="Retrying…"
        onClick={() => void action.retry()}
        className="rounded-lg border border-red-500/50 px-2.5 py-1 text-xs text-red-400 disabled:opacity-50"
      >
        Retry
      </ActionButton>
    </div>
  );
}
