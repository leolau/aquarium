"use client";

import { useEffect } from "react";

import type { ChatApprovalRequest } from "@/types";

/** Human labels for the approval choices the agent offers. */
export const CHOICE_LABELS: Record<string, string> = {
  once: "Approve",
  session: "Approve for this chat",
  always: "Always approve",
  deny: "Deny",
};

/** Display order of the approval choices (shared with `ApprovalCard`). */
export const CHOICE_ORDER: readonly string[] = ["once", "session", "always", "deny"];

export interface ApprovalModalProps {
  request: ChatApprovalRequest;
  busy: boolean;
  onResolve(choice: string): void;
}

/**
 * The approve/deny surface shown when an approval-gated tool blocks the turn
 * (`approval.request`). This is the approval surface agent-home chat previously
 * lacked — without it gated tools failed closed with `no_surface`.
 *
 * Rendered as a modal (a bottom sheet on phones, a centred dialog from `sm`
 * up) rather than a card inline at the end of the thread: inline, the buttons
 * sat below the fold behind the composer and were awkward to hit on a phone.
 *
 * There is deliberately **no dismiss affordance** (no backdrop click, no Esc,
 * no close button): the agent is paused until a choice is submitted, so
 * dismissing would strand the turn with no way to answer it. "Deny" is the
 * explicit way out.
 */
export function ApprovalModal({ request, busy, onResolve }: ApprovalModalProps) {
  const choices = CHOICE_ORDER.filter((c) => request.choices.includes(c));
  const label =
    request.command || request.toolName || request.patternKey || "a tool";

  // Stop the thread behind the sheet from scrolling under the user's thumb.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  return (
    <div
      data-component="ApprovalModal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="approval-modal-title"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4"
    >
      <div className="flex max-h-[85dvh] w-full max-w-md flex-col rounded-t-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4 pb-[calc(1rem+var(--safe-bottom))] sm:rounded-2xl sm:pb-4">
        <h2
          id="approval-modal-title"
          className="text-base font-semibold text-[var(--color-fg)]"
        >
          Approval needed
        </h2>
        <div className="mt-2 min-h-0 flex-1 overflow-y-auto">
          <p className="text-sm text-[var(--color-muted)]">
            {request.description ||
              "Your agent needs approval before running this tool."}
          </p>
          <pre className="mt-2 whitespace-pre-wrap break-words rounded-xl bg-[var(--color-surface-2)] p-3 font-mono text-xs text-[var(--color-fg)]">
            {label}
          </pre>
        </div>
        <div className="mt-4 flex flex-col gap-2">
          {choices.map((choice, index) => {
            const isDeny = choice === "deny";
            return (
              <button
                key={choice}
                type="button"
                data-appmcp-deny="consent"
                disabled={busy}
                autoFocus={index === 0}
                onClick={() => onResolve(choice)}
                className={`w-full rounded-xl px-4 py-3 text-sm font-semibold disabled:opacity-50 ${
                  isDeny
                    ? "mt-1 border border-[var(--color-border)] text-red-300"
                    : choice === "once"
                      ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
                      : "border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-fg)]"
                }`}
              >
                {CHOICE_LABELS[choice] ?? choice}
              </button>
            );
          })}
        </div>
        {busy ? (
          <p className="mt-3 text-center text-xs text-[var(--color-muted)]">
            Submitting your decision…
          </p>
        ) : null}
      </div>
    </div>
  );
}
