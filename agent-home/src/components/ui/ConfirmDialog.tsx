"use client";

import { useEffect } from "react";

import { ActionButton } from "@/components/ui/ActionButton";

export interface ConfirmDialogProps {
  title: string;
  body: string;
  /** Label for the destructive action, e.g. "Disconnect" / "Sign out". */
  confirmLabel: string;
  cancelLabel?: string;
  busy?: boolean;
  /** Return the promise: the button stays busy and locked until it settles. */
  onConfirm(): unknown;
  onCancel(): void;
}

/**
 * Shared two-tap confirmation for destructive settings actions (disconnect,
 * sign out, …). Rendered as a modal — a bottom sheet on phones, a centred
 * dialog from `sm` up — matching ApprovalModal's shape.
 *
 * Unlike ApprovalModal it CAN be dismissed (backdrop click, Esc, Cancel):
 * nothing is paused waiting on an answer, so an accidental tap must be
 * escapable. The confirm button is styled destructive like the model
 * picker's disconnect confirm.
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel = "Cancel",
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  // Stop the page behind the sheet from scrolling under the user's thumb.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      data-component="ConfirmDialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-t-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4 pb-[calc(1rem+var(--safe-bottom))] sm:rounded-2xl sm:pb-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="confirm-dialog-title"
          className="text-base font-semibold text-[var(--color-fg)]"
        >
          {title}
        </h2>
        <p className="mt-2 text-sm text-[var(--color-muted)]">{body}</p>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="rounded-full border border-[var(--color-border)] px-4 py-1.5 text-xs disabled:opacity-60"
          >
            {cancelLabel}
          </button>
          <ActionButton
            busy={busy}
            busyLabel={confirmLabel}
            autoFocus
            onAction={onConfirm}
            className="ml-auto inline-flex items-center gap-2 rounded-full bg-red-500/80 px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
          >
            {confirmLabel}
          </ActionButton>
        </div>
      </div>
    </div>
  );
}
