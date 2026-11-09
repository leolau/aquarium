"use client";

import type { PinSuggestion } from "@/types/landing";

import { PinIcon, SparklesIcon, XIcon } from "@/components/ui/icons";

/**
 * The agent's page-load nudge (Figma `pin-suggestion` 4:54): unfinished chats
 * worth keeping on top. "Pin …" pins every suggested chat; "Not now" and ✕
 * dismiss them until they see new activity.
 */
export function PinSuggestionCard({
  suggestions,
  busy = false,
  onAccept,
  onDismiss,
}: {
  suggestions: PinSuggestion[];
  busy?: boolean;
  onAccept: (ids: string[]) => void;
  onDismiss: (ids: string[]) => void;
}) {
  if (suggestions.length === 0) return null;
  const ids = suggestions.map((s) => s.session_id);
  const n = suggestions.length;
  const title = `${n} unfinished chat${n === 1 ? "" : "s"} worth pinning`;
  const ask = n === 1 ? "Pin it so it stays on top?" : "Pin them so they stay on top?";
  const accept = n === 1 ? "Pin it" : n === 2 ? "Pin both" : "Pin all";

  return (
    <section
      data-component="PinSuggestionCard"
      aria-label="Pin suggestion"
      aria-busy={busy || undefined}
      className="flex flex-col gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
    >
      <div className="flex items-start gap-2">
        <SparklesIcon size={14} className="mt-0.5 shrink-0 text-[var(--color-accent)]" />
        <h3 className="min-w-0 flex-1 text-[13px] font-medium leading-[18px] text-[var(--color-fg)]">
          {title}
        </h3>
        <button
          type="button"
          onClick={() => onDismiss(ids)}
          disabled={busy}
          aria-label="Dismiss suggestion"
          className="grid size-5 shrink-0 place-items-center lg:!min-h-0 rounded-[var(--radius-sm)] text-[var(--color-muted)] hover:text-[var(--color-fg)] disabled:opacity-50"
        >
          <XIcon size={14} />
        </button>
      </div>
      <ul aria-label="Suggested chats" className="flex max-h-40 flex-col gap-1 overflow-y-auto">
        {suggestions.map((s) => (
          <li
            key={s.session_id}
            data-slot="suggested-chat"
            className="flex min-w-0 flex-col rounded-[var(--radius-md)] bg-[var(--color-surface-2)] px-2 py-1.5"
          >
            <span className="break-words text-xs font-medium leading-4 text-[var(--color-fg)]">
              {s.title?.trim() || "Untitled chat"}
            </span>
            <span className="text-[11px] leading-[14px] text-[var(--color-muted)]">
              {s.reason || "stopped mid-way"}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-xs font-medium leading-4 text-[var(--color-muted)]">{ask}</p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onAccept(ids)}
          disabled={busy}
          className="inline-flex items-center gap-2 rounded-[var(--radius-lg)] bg-[var(--color-accent)] lg:!min-h-0 px-3 py-2 text-[13px] font-medium leading-[18px] text-[var(--color-accent-fg)] hover:opacity-90 disabled:opacity-60"
        >
          <PinIcon size={14} />
          {busy ? "Pinning…" : accept}
        </button>
        <button
          type="button"
          onClick={() => onDismiss(ids)}
          disabled={busy}
          className="rounded-[var(--radius-lg)] px-3 py-2 lg:!min-h-0 text-[13px] font-medium leading-[18px] text-[var(--color-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-fg)] disabled:opacity-60"
        >
          Not now
        </button>
      </div>
    </section>
  );
}
