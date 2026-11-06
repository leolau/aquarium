"use client";

import { useState } from "react";

import { ActionButton } from "@/components/projects/ActionButton";
import { ActionError } from "@/components/projects/ActionError";
import { useProjectAction } from "@/components/projects/useProjectAction";
import { BusyRegion } from "@/components/ui/BusyRegion";
import type { ProjectCardDetail } from "@/types";

/**
 * Operator recovery for a card (§12): **Stop** terminates a stuck/running
 * worker and parks the card in blocked (no re-run); **Re-run** reclaims a
 * running card — kill, release the claim, reset to ready — and the
 * dispatcher respawns a fresh worker on its next tick. A blocked card holds
 * no claim (Stop released it), so its way back is **unblock**: the person's
 * answer (if any) lands on the card's thread first, then the card moves to
 * ready and the next worker reads the current brief plus that thread.
 */
type Action = "stop" | "reclaim" | "unblock";

/** Matches `projects_board_api._REASON_MAX_LEN`. */
export const ANSWER_MAX_LEN = 2_000;

export function unblockPath(slug: string, taskId: string): string {
  return `/api/projects/${encodeURIComponent(slug)}/cards/${encodeURIComponent(taskId)}/unblock`;
}

export function CardActions({
  slug,
  taskId,
  status,
  awaitingApproval = false,
  parked = false,
  onUpdated,
  answer: answerProp,
  onAnswerChange,
}: {
  slug: string;
  taskId: string;
  status: string;
  /** A blocked card waiting on an approval is released by answering it,
   * not by Make ready (its worker would only ask again). */
  awaitingApproval?: boolean;
  /** Parked in triage by the unblock-loop breaker: only a person re-runs
   * it (the same unblock route, which also clears its loop count). */
  parked?: boolean;
  /** The card as the server returned it after a write, so the page can
   * drop the stale status before the refresh lands. */
  onUpdated?: (card: ProjectCardDetail) => void;
  /** Controlled answer text, so the page can share it with Save & re-run. */
  answer?: string;
  onAnswerChange?: (answer: string) => void;
}) {
  // One lock for the card: busy from the click until the refreshed page
  // has rendered.
  const action = useProjectAction<ProjectCardDetail>();
  const [last, setLast] = useState<Action | null>(null);
  const inFlight = action.busy;
  const busy = inFlight ? last : null;
  const [ownAnswer, setOwnAnswer] = useState("");
  const answer = answerProp ?? ownAnswer;
  const setAnswer = (next: string) => {
    setOwnAnswer(next);
    onAnswerChange?.(next);
  };

  if (status !== "running" && status !== "ready" && status !== "blocked" && !parked) {
    return null;
  }

  const act = (next: Action) => {
    if (inFlight) return;
    setLast(next);
    const base = `/api/projects/${encodeURIComponent(slug)}/cards/${encodeURIComponent(taskId)}`;
    if (next !== "unblock") {
      void action.run(`${base}/${next}`);
      return;
    }
    const reason = answer.trim();
    void action.run(unblockPath(slug, taskId), {
      body: reason ? { reason } : {},
      onSuccess: (card) => {
        setAnswer("");
        onUpdated?.(card);
      },
    });
  };

  return (
    <div data-component="CardActions" className="mt-3 flex flex-wrap items-center gap-2">
      {status !== "blocked" && !parked ? (
        <BusyRegion busy={busy === "stop"} label="Stopping…">
          <ActionButton
            busy={busy === "stop"}
            pendingLabel="Stopping…"
            onClick={() => act("stop")}
            disabled={inFlight}
            className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium disabled:opacity-40"
          >
            Stop
          </ActionButton>
        </BusyRegion>
      ) : null}
      {status === "running" ? (
        <BusyRegion busy={busy === "reclaim"} label="Re-queueing…">
          <ActionButton
            busy={busy === "reclaim"}
            pendingLabel="Re-queueing…"
            onClick={() => act("reclaim")}
            disabled={inFlight}
            className="rounded-lg border border-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-[var(--color-accent)] disabled:opacity-40"
          >
            Re-run
          </ActionButton>
        </BusyRegion>
      ) : null}
      {(status === "blocked" || parked) && !awaitingApproval ? (
        <BusyRegion busy={busy === "unblock"} label="Re-running…" className="w-full">
          <div data-component="CardRerun" className="flex w-full flex-col gap-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-[var(--color-muted)]">
                Answer the agent
              </span>
              <textarea
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                maxLength={ANSWER_MAX_LEN}
                rows={3}
                disabled={inFlight}
                placeholder="e.g. paste the Drive link, or the detail it asked for"
                className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
              />
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <ActionButton
                busy={busy === "unblock"}
                pendingLabel="Re-running…"
                onClick={() => act("unblock")}
                disabled={inFlight}
                className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-[var(--color-accent-fg)] disabled:opacity-40"
              >
                {answer.trim() ? "Re-run with my answer" : "Re-run card"}
              </ActionButton>
            </div>
            <p className="text-xs text-[var(--color-muted)]">
              The agent starts this card again using the current brief and
              your answer.
            </p>
          </div>
        </BusyRegion>
      ) : null}
      <ActionError action={action} className="flex w-full flex-wrap items-center gap-2 text-xs text-red-300" />
    </div>
  );
}
