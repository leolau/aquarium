"use client";

import { useEffect, type ReactNode } from "react";

/**
 * A dismissable modal panel: a bottom sheet on phones, a centred dialog from
 * `sm` up (`side` docks it to the right edge on desktop, like a drawer).
 * Esc, the ✕ and a backdrop tap all close it.
 */
export function Sheet({
  title,
  onClose,
  children,
  footer,
  side = false,
  wide = false,
  full = false,
  component = "Sheet",
}: {
  title: ReactNode;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
  side?: boolean;
  wide?: boolean;
  /** Near full-screen on desktop (e.g. a maximized panel) and full-height on phones. */
  full?: boolean;
  component?: string;
}) {
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const frame = side
    ? "sm:items-stretch sm:justify-end sm:p-0"
    : "sm:items-center sm:p-4";
  const panel = side
    ? "sm:h-full sm:max-w-md sm:rounded-none sm:border-y-0 sm:border-r-0"
    : `sm:rounded-2xl ${full ? "h-[92vh] sm:h-[90vh] sm:max-w-5xl" : wide ? "sm:max-w-2xl" : "sm:max-w-lg"}`;

  return (
    <div
      data-component={component}
      role="dialog"
      aria-modal="true"
      aria-label={typeof title === "string" ? title : undefined}
      className={`fixed inset-0 z-[70] flex items-end justify-center bg-black/60 p-0 ${frame}`}
      onClick={onClose}
    >
      <div
        className={`flex max-h-[92vh] w-full flex-col rounded-t-2xl border border-[var(--color-border)] bg-[var(--color-bg)] sm:max-h-full ${panel}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-3">
          <h2 className="min-w-0 flex-1 truncate text-base font-semibold">{title}</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="rounded-full px-2 py-1 text-sm text-[var(--color-muted)] hover:bg-[var(--color-surface-2)]"
          >
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
        {footer ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] px-4 py-3 pb-[calc(0.75rem+var(--safe-bottom))] sm:pb-3">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export const inputClass =
  "w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]";

export const primaryButtonClass =
  "rounded-full bg-[var(--color-accent)] px-4 py-1.5 text-xs font-medium text-[var(--color-accent-fg)] disabled:opacity-60";

export const secondaryButtonClass =
  "rounded-full border border-[var(--color-border)] px-4 py-1.5 text-xs disabled:opacity-60";

export const dangerButtonClass =
  "rounded-full border border-red-500/40 px-4 py-1.5 text-xs text-red-300 disabled:opacity-60";
