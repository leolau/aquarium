"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";

import { ActionButton } from "@/components/projects/ActionButton";
import type { DashAction } from "@/components/projects/dashboard/nextAction";
import { confirmedText, mutationSteps } from "@/components/projects/dashboard/steps";
import type { ProjectTab } from "@/components/projects/tabs/types";
import { useProjectAction } from "@/components/projects/useProjectAction";

export type DashButtonVariant = "primary" | "secondary" | "row";

const CLASS: Record<DashButtonVariant, string> = {
  primary:
    "rounded-xl bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-60",
  secondary:
    "rounded-xl border border-[var(--color-border)] px-4 py-2 text-sm disabled:opacity-60",
  row: "shrink-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-medium disabled:opacity-60",
};

/**
 * One Dashboard button. Mutations go through `useProjectAction` (one hook per
 * button, so rows lock independently); multi-request flows such as
 * "Approve N cards & resume work" hold one lock across every request and
 * only refresh after the last one. Navigation intents just move the person.
 */
export function DashActionButton({
  slug,
  action,
  variant,
  onNavigate,
  onChangeRequest,
  disabled = false,
  onConfirmed,
}: {
  slug: string;
  action: DashAction;
  variant: DashButtonVariant;
  onNavigate: (tab: ProjectTab) => void;
  onChangeRequest: (initialText?: string) => void;
  disabled?: boolean;
  /** Takes over the confirmation line, for a host that outlives the button
   * (the journey bar re-keys its button as soon as the step advances). */
  onConfirmed?: (text: string) => void;
}) {
  const { intent } = action;
  const className = CLASS[variant];
  const projectPath = `/projects/${encodeURIComponent(slug)}`;
  if (intent.kind === "navigate") {
    return (
      <button type="button" className={className} onClick={() => onNavigate(intent.tab)}>
        {action.label}
      </button>
    );
  }
  if (intent.kind === "change_request") {
    return (
      <button type="button" className={className} onClick={() => onChangeRequest()}>
        {action.label}
      </button>
    );
  }
  if (intent.kind === "open_run") {
    return (
      <Link href={`${projectPath}/runs/${intent.runNo}`} className={`inline-block ${className}`}>
        {action.label}
      </Link>
    );
  }
  if (intent.kind === "open_card") {
    return (
      <Link
        href={`${projectPath}/cards/${encodeURIComponent(intent.taskId)}`}
        className={`inline-block ${className}`}
      >
        {action.label}
      </Link>
    );
  }
  return (
    <MutationButton
      slug={slug}
      action={action}
      className={className}
      disabled={disabled}
      onConfirmed={onConfirmed}
    />
  );
}

function MutationButton({
  slug,
  action,
  className,
  disabled,
  onConfirmed,
}: {
  slug: string;
  action: DashAction;
  className: string;
  disabled: boolean;
  onConfirmed?: (text: string) => void;
}) {
  const mutation = useProjectAction<Record<string, unknown>>();
  // A flow of several requests: the hook's own lock is released between
  // them, so this one is held from the first click to the last response.
  const flowLock = useRef(false);
  const nextStep = useRef(0);
  const [flowBusy, setFlowBusy] = useState(false);
  const [confirmed, setConfirmed] = useState<string | null>(null);

  const go = useCallback(
    async (retrying: boolean) => {
      if (flowLock.current) return;
      flowLock.current = true;
      setFlowBusy(true);
      try {
        const steps = mutationSteps(slug, action.intent);
        let last: unknown = null;
        const from = nextStep.current;
        for (let i = from; i < steps.length; i++) {
          const step = steps[i];
          const isLast = i === steps.length - 1;
          const result =
            retrying && i === from
              ? await mutation.retry()
              : await mutation.run(step.path, {
                  method: step.method,
                  body: step.body,
                  skipRefresh: !isLast,
                });
          if (!result || !result.ok) return;
          last = result.data;
          nextStep.current = i + 1;
        }
        const text = confirmedText(action.intent, last);
        setConfirmed(text);
        onConfirmed?.(text);
      } finally {
        flowLock.current = false;
        setFlowBusy(false);
      }
    },
    [action.intent, mutation, onConfirmed, slug],
  );

  const busy = flowBusy || mutation.busy;
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <ActionButton
        busy={busy}
        disabled={disabled || confirmed !== null}
        pendingLabel={action.pendingLabel ?? "Working…"}
        className={className}
        onClick={() => void go(false)}
      >
        {confirmed !== null ? "Done ✓" : action.label}
      </ActionButton>
      {confirmed !== null && !onConfirmed ? (
        <span role="status" className="text-xs text-emerald-400">
          {confirmed}
        </span>
      ) : null}
      {mutation.error && !busy ? (
        <span role="alert" className="text-xs text-[var(--color-danger)]">
          {mutation.error}{" "}
          <button
            type="button"
            className="font-medium text-[var(--color-accent)] underline-offset-2 hover:underline"
            onClick={() => void go(true)}
          >
            Try again
          </button>
        </span>
      ) : null}
    </span>
  );
}
