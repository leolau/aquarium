"use client";

import { chatHeaderActionsRef } from "@/lib/chat/header-actions";

/**
 * Compact action buttons rendered in the `MobileShell` header bar, next to
 * the "Chat" title.  The "Archived" and "+ New" buttons used to live inside
 * the `SessionTabs` strip where they ate ~150px of horizontal space on a
 * phone; moving them to the header gives the session chips the full width.
 *
 * The callbacks are populated by `ChatPane` via the shared
 * `chatHeaderActionsRef` — see `lib/chat/header-actions.ts` for the rationale.
 * The `onClick` handlers read the ref at click time so they always invoke the
 * latest callback.
 */
export function ChatHeaderActions() {
  return (
    <div data-component="ChatHeaderActions" className="flex items-center gap-2">
      <button
        type="button"
        data-action="session-details"
        onClick={() => chatHeaderActionsRef.current.openDetails()}
        aria-label="Conversation details"
        title="Rename, category and tags"
        className="shrink-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-muted)]"
      >
        Details
      </button>
      <button
        type="button"
        onClick={() => chatHeaderActionsRef.current.openArchived()}
        aria-label="Show archived conversations"
        title="Archived conversations"
        className="shrink-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-muted)]"
      >
        Archived
      </button>
      <button
        type="button"
        onClick={() => chatHeaderActionsRef.current.startNew()}
        aria-label="New conversation"
        className="shrink-0 rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm font-semibold text-[var(--color-accent-fg)]"
      >
        + New
      </button>
    </div>
  );
}
