"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { CardActions } from "@/components/projects/CardActions";
import { CardApprovals } from "@/components/projects/CardApprovals";
import { CardEditor } from "@/components/projects/CardEditor";
import { CardModelCalls } from "@/components/projects/CardModelCalls";
import { durationLabel } from "@/components/projects/format";
import { parkedText } from "@/components/projects/live/liveState";
import { useCardLive } from "@/components/projects/useCardLive";
import { Spinner } from "@/components/ui/Spinner";
import { Pill, type Tone } from "@/components/ui/Pill";
import { useServerState } from "@/components/ui/useRefresh";
import type { ProjectCardDetail } from "@/types";
import { useTimeLabel } from "@/components/projects/useTimeLabel";
import { useHydrated } from "@/lib/use-hydrated";

const STATUS_TONE: Record<string, Tone> = {
  todo: "muted",
  triage: "muted",
  running: "accent",
  review: "warning",
  blocked: "danger",
  done: "success",
  archived: "muted",
};

/**
 * Human framing for `kanban_db.VALID_BLOCK_KINDS` — matches the language
 * `kanban_block`'s tool schema uses when asking the worker why it stopped,
 * so the human sees the same vocabulary the agent chose from.
 */
const BLOCK_KIND_LABEL: Record<string, string> = {
  needs_input: "Needs your input",
  capability: "The agent can't do this — needs a human",
  transient: "Hit a snag — may clear on retry",
};

/** Why this card stopped, in one line: `kanban_block`'s required `reason`
 * text, or a fallback for the (now rare) case a caller blocked it without
 * one — e.g. a manual column move via the board, not the agent tool. */
function blockReasonText(card: ProjectCardDetail): string {
  const reason = card.latest_summary ?? card.result;
  return reason && reason.trim()
    ? reason
    : "No reason was recorded for this block.";
}

/**
 * One card (§13): everything the board row knows — stage, assignee, step,
 * the body, the result and the latest worker summary — plus the hand edits
 * a member may make (title / brief / assignee / column) and the operator
 * recovery actions (stop / re-run).
 */
export function CardDetailView({
  slug,
  card: initial,
  profiles = [],
  archived = false,
}: {
  slug: string;
  card: ProjectCardDetail;
  /** The project's profiles — the only valid assignees. */
  profiles?: string[];
  /** §13: an archived project's cards are read-only. */
  archived?: boolean;
}) {
  const timeLabel = useTimeLabel();
  const hydrated = useHydrated();
  const [card, setCard] = useServerState(initial);

  // A worker runs in its own process — there is no *in-memory* reasoning
  // stream the way an inline Projects run's session has, but its output
  // is captured to a durable log the box already cleans up for display
  // (`worker_log_tail`). Heartbeat notes and comments are the lighter
  // progress signal alongside it. Re-read the card while it's `running`
  // so any of this actually reaches the page instead of sitting frozen
  // at whatever the server rendered on load (found confusing in
  // production: a running card showed no update at all).
  useCardLive(slug, card.id, card.status, (fresh) =>
    setCard((prev) => ({ ...prev, ...fresh })),
  );

  // Unblock answers with the card row (no comments / log tail), so merge it
  // over what the page already has: the badge and banner flip at once and
  // the refresh fills in the rest.
  const [answer, setAnswer] = useState("");
  const applyServerCard = (fresh: ProjectCardDetail) => {
    setAnswer("");
    setCard((prev) => ({ ...prev, ...fresh }));
  };

  const tone = STATUS_TONE[card.status] ?? "muted";
  const isRunning = card.status === "running";
  const heartbeat = card.latest_heartbeat ?? null;
  const comments = card.comments ?? [];
  const logTail = card.worker_log_tail ?? null;
  const approvals =
    card.status === "blocked" ? (card.pending_approvals ?? []) : [];

  // A ticking clock, only while running (matches the chat pane's own
  // elapsed-time pattern) — the one thing that can always be shown, even
  // before any heartbeat/log content has arrived.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isRunning) return;
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [isRunning]);
  const elapsedSeconds =
    isRunning && card.started_at != null && hydrated
      ? Math.max(0, Math.floor(now / 1000) - card.started_at)
      : null;
  const timing = [
    `created ${timeLabel(card.created_at)}`,
    card.started_at != null ? `started ${timeLabel(card.started_at)}` : null,
    card.completed_at != null
      ? `completed ${timeLabel(card.completed_at)}`
      : null,
    card.age?.time_to_complete_seconds != null
      ? `took ${durationLabel(card.age.time_to_complete_seconds)}`
      : null,
  ].filter(Boolean);

  return (
    <div data-component="CardDetailView" className="flex flex-col gap-4">
      <header
        data-component="CardHeader"
        className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      >
        <div className="flex items-center gap-2">
          <h1 className="min-w-0 flex-1 text-lg font-semibold">{card.title}</h1>
          <Pill tone={tone}>{card.status}</Pill>
        </div>
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          {[
            card.assignee ?? "unassigned",
            card.current_step_key ? `step ${card.current_step_key}` : null,
            card.tenant ? `tenant ${card.tenant}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          {card.toolsets && card.toolsets.length > 0
            ? `worker tools: ${card.toolsets.join(", ")}`
            : "worker tools: full profile surface"}
        </p>
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          {timing.join(" · ")}
        </p>
        {card.status === "blocked" ? (
          <div
            data-component="CardBlockedReason"
            className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 p-3"
          >
            <p className="text-xs font-medium uppercase tracking-wide text-red-300">
              {card.block_kind
                ? (BLOCK_KIND_LABEL[card.block_kind] ?? "Blocked")
                : "Blocked"}
            </p>
            <p className="mt-1 whitespace-pre-wrap text-sm">
              {blockReasonText(card)}
            </p>
            <CardApprovals
              slug={slug}
              taskId={card.id}
              approvals={approvals}
              canAct={!archived}
            />
            {archived ? null : approvals.length > 0 ? (
              <p className="mt-2 text-xs text-[var(--color-muted)]">
                Review each request above and allow or deny it. The card runs
                again once nothing is left waiting.
              </p>
            ) : (
              <p className="mt-2 text-xs text-[var(--color-muted)]">
                Answer the agent below, or use Edit card to change the brief,
                then re-run the card.
              </p>
            )}
          </div>
        ) : null}
        {!card.parked && card.replan?.status === "activated" ? (
          <div
            data-component="CardSuperseded"
            className="mt-3 rounded-xl border border-sky-500/30 bg-sky-500/10 p-3 text-sm"
          >
            Re-planned automatically after this card parked
            {card.replan.rev ? ` — plan revision ${card.replan.rev} is active` : ""} and the run
            continues on it. This card is superseded and won&apos;t be re-run.
          </div>
        ) : null}
        {card.parked ? (
          <div
            data-component="CardParked"
            className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3"
          >
            <p className="text-xs font-medium uppercase tracking-wide text-amber-300">
              Needs you
            </p>
            <p className="mt-1 text-sm">
              {(() => {
                const text = parkedText(card);
                return text.charAt(0).toUpperCase() + text.slice(1);
              })()}
              .
            </p>
            <p className="mt-2 text-xs text-[var(--color-muted)]">
              It kept blocking for the same reason, so it won&apos;t be
              restarted automatically.{" "}
              <Link
                href={`/projects/${encodeURIComponent(slug)}?tab=plan`}
                className="text-[var(--color-accent)]"
              >
                Review the plan
              </Link>
              , or answer the agent below and re-run the card.
            </p>
          </div>
        ) : null}
        {!archived ? (
          <>
            <CardActions
              slug={slug}
              taskId={card.id}
              status={card.status}
              awaitingApproval={approvals.length > 0}
              parked={card.parked === true}
              onUpdated={applyServerCard}
              answer={answer}
              onAnswerChange={setAnswer}
            />
            <CardEditor
              slug={slug}
              card={card}
              profiles={profiles}
              canRerun={card.status === "blocked" && approvals.length === 0}
              rerunAnswer={answer}
              onUpdated={applyServerCard}
            />
          </>
        ) : null}
        <Link
          href={`/projects/${encodeURIComponent(slug)}`}
          className="mt-2 inline-block text-xs text-[var(--color-accent)]"
        >
          ‹ Back to the project
        </Link>
      </header>

      {isRunning ? (
        <section
          data-component="CardProgress"
          className="rounded-2xl border border-[var(--color-accent)]/30 bg-[var(--color-surface)] p-4"
        >
          <h2 className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-[var(--color-muted)]">
            <Spinner className="text-[var(--color-accent)]" />
            What&apos;s happening
            {elapsedSeconds != null ? (
              <span className="ml-auto font-normal normal-case text-[var(--color-muted)]">
                working for {durationLabel(elapsedSeconds)}
              </span>
            ) : null}
          </h2>
          {heartbeat ? (
            <p className="mt-2 whitespace-pre-wrap text-sm">
              {heartbeat.note}
              <span className="ml-2 text-xs text-[var(--color-muted)]">
                updated {timeLabel(heartbeat.created_at, "ago")}
              </span>
            </p>
          ) : null}
          {logTail ? (
            <pre
              data-component="CardWorkerLog"
              className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap rounded-lg bg-[var(--color-surface-2)] p-2 text-xs text-[var(--color-muted)]"
            >
              {logTail}
            </pre>
          ) : !heartbeat ? (
            <p className="mt-2 text-sm text-[var(--color-muted)]">
              A worker is on it, in its own process. Waiting for its first
              progress update&hellip;
            </p>
          ) : null}
        </section>
      ) : null}

      {card.body ? (
        <section
          data-component="CardBody"
          className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
        >
          <h2 className="text-xs uppercase tracking-wide text-[var(--color-muted)]">
            Brief
          </h2>
          <p className="mt-2 whitespace-pre-wrap text-sm">{card.body}</p>
        </section>
      ) : null}

      {/* Blocked already shows this text, framed as "why + what to do",
          in the header banner above — repeating it here would just be the
          same sentence twice. */}
      {card.status !== "blocked" && (card.latest_summary || card.result) ? (
        <section
          data-component="CardResult"
          className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
        >
          <h2 className="text-xs uppercase tracking-wide text-[var(--color-muted)]">
            Latest from the worker
          </h2>
          <p className="mt-2 whitespace-pre-wrap text-sm">
            {card.latest_summary ?? card.result}
          </p>
        </section>
      ) : null}

      {isRunning || (card.model_calls?.rows.length ?? 0) > 0 ? (
        <CardModelCalls data={card.model_calls} />
      ) : null}

      {comments.length > 0 ? (
        <section
          data-component="CardUpdates"
          className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
        >
          <h2 className="text-xs uppercase tracking-wide text-[var(--color-muted)]">
            Updates
          </h2>
          <ul className="mt-2 flex flex-col gap-3">
            {[...comments].reverse().map((c, i) => (
              <li key={`${c.created_at}-${i}`} className="text-sm">
                <p className="whitespace-pre-wrap">{c.body}</p>
                <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                  {c.author} · {timeLabel(c.created_at)}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
