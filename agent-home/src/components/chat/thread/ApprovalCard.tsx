"use client";

import { useEffect, useId, useRef } from "react";

import {
  CHOICE_LABELS,
  CHOICE_ORDER,
  type ApprovalModalProps,
} from "@/components/chat/ApprovalModal";

/**
 * The approve/deny decision for an approval-gated tool, rendered inline at the
 * end of the thread (same choices as `ApprovalModal`). There is deliberately
 * no dismiss affordance: the agent is paused until a choice is submitted, and
 * "Deny" is the explicit way out. On mount it scrolls itself into view and
 * focuses the first choice so the decision is never below the fold.
 */
export function ApprovalCard({ request, busy, onResolve }: ApprovalModalProps) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const choices = CHOICE_ORDER.filter((c) => request.choices.includes(c));
  const label =
    request.command || request.toolName || request.patternKey || "a tool";

  useEffect(() => {
    ref.current?.scrollIntoView?.({ block: "nearest" });
  }, []);

  return (
    <div
      ref={ref}
      data-component="ApprovalCard"
      role="group"
      aria-labelledby={titleId}
      className="w-full max-w-md rounded-2xl border border-amber-400/60 bg-[var(--color-surface-2)] p-3"
    >
      <h2 id={titleId} className="text-sm font-semibold text-[var(--color-fg)]">
        Approval needed
      </h2>
      <p className="mt-1 text-sm text-[var(--color-muted)]">
        {request.description ||
          "Your agent needs approval before running this tool."}
      </p>
      <pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-xl bg-[var(--color-surface)] p-3 font-mono text-xs text-[var(--color-fg)]">
        {label}
      </pre>
      <div className="mt-3 flex flex-wrap gap-2">
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
              className={`rounded-xl px-3 py-2 text-sm font-semibold disabled:opacity-50 ${
                isDeny
                  ? "border border-[var(--color-border)] text-red-300"
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
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          Submitting your decision…
        </p>
      ) : null}
    </div>
  );
}
