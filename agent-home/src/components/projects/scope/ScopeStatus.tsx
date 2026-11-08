"use client";

import { ActionButton } from "@/components/projects/ActionButton";
import { CARD, SECONDARY } from "@/components/projects/scope/ui";

/** While the agent writes its questions: a status line and a skeleton. */
export function ScopeRunning() {
  return (
    <section data-component="ClarifyRunning" className={CARD} aria-busy="true">
      <p role="status" className="text-sm">
        The agent is reading the brief and inputs…
      </p>
      <div aria-hidden className="mt-3 flex animate-pulse flex-col gap-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex flex-col gap-2">
            <div className="h-3 w-16 rounded-full bg-[var(--color-surface-2)]" />
            <div className="h-4 w-4/5 rounded bg-[var(--color-surface-2)]" />
            <div className="h-3 w-3/5 rounded bg-[var(--color-surface-2)]" />
          </div>
        ))}
      </div>
    </section>
  );
}

/** First read still on its way. */
export function ScopeLoading() {
  return (
    <section data-component="ClarifyLoading" className={CARD} aria-busy="true">
      <div aria-hidden className="flex animate-pulse flex-col gap-2">
        <div className="h-4 w-2/3 rounded bg-[var(--color-surface-2)]" />
        <div className="h-3 w-1/2 rounded bg-[var(--color-surface-2)]" />
      </div>
    </section>
  );
}

/** The last question job failed. Retry starts a *new* job (a fresh request). */
export function ScopeJobFailed({
  detail,
  canRetry,
  busy,
  onRetry,
}: {
  detail: string | null | undefined;
  canRetry: boolean;
  busy: boolean;
  onRetry: () => void;
}) {
  return (
    <section
      data-component="ClarifyJobFailed"
      className="flex flex-wrap items-center gap-2 rounded-2xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-300"
    >
      <span role="alert" className="min-w-0 flex-1">
        The agent couldn&rsquo;t write its questions{detail ? `: ${detail}` : "."}
      </span>
      {canRetry ? (
        <ActionButton
          busy={busy}
          pendingLabel="Retrying…"
          className="rounded-lg border border-red-500/50 px-2.5 py-1 text-xs text-red-300 disabled:opacity-50"
          onClick={onRetry}
        >
          Retry
        </ActionButton>
      ) : null}
    </section>
  );
}

/** The first read failed and there is nothing to show. */
export function ScopeLoadFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <section data-component="ClarifyLoadFailed" className={CARD}>
      <p role="alert" className="text-sm text-[var(--color-danger)]">
        {message}
      </p>
      <button type="button" className={`mt-2 ${SECONDARY}`} onClick={onRetry}>
        Try again
      </button>
    </section>
  );
}
