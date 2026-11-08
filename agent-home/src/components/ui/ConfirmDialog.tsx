"use client";

import { useEffect, type ReactNode } from "react";

import { ActionButton } from "@/components/ui/ActionButton";
import { useT } from "@/i18n";

export interface ConfirmDialogProps {
  title: string;
  body: string;
  /** Label for the destructive action, e.g. "Disconnect" / "Sign out". */
  confirmLabel: string;
  cancelLabel?: string;
  busy?: boolean;
  /** "danger" (default) for destructive actions, "accent" for a plain confirm. */
  tone?: "danger" | "accent";
  /** Extra content between the body and the buttons, e.g. a text field. */
  children?: ReactNode;
  confirmDisabled?: boolean;
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
  cancelLabel,
  busy = false,
  tone = "danger",
  children,
  confirmDisabled = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const t = useT("common");
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
      className="fixed inset-0 z-[70] flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4"
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
        {children}
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="rounded-full border border-[var(--color-border)] px-4 py-1.5 text-xs disabled:opacity-60"
          >
            {cancelLabel ?? t("cancel")}
          </button>
          <ActionButton
            busy={busy}
            busyLabel={confirmLabel}
            autoFocus={!children}
            disabled={confirmDisabled}
            onAction={onConfirm}
            className={`ml-auto inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-xs font-semibold disabled:opacity-60 ${
              tone === "danger"
                ? "bg-[var(--color-danger)] text-[var(--color-bg)]"
                : "bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
            }`}
          >
            {confirmLabel}
          </ActionButton>
        </div>
      </div>
    </div>
  );
}
