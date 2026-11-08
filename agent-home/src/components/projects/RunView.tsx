"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { ActionButton } from "@/components/projects/ActionButton";
import { ActionError } from "@/components/projects/ActionError";
import { useProjectAction } from "@/components/projects/useProjectAction";

import {
  durationLabel,
} from "@/components/projects/format";
import { parkedText } from "@/components/projects/live/liveState";
import { unwrapRunEnvelope } from "@/components/projects/envelopes";
import { useRunLive } from "@/components/projects/useRunLive";
import { useRunActivity } from "@/components/projects/useRunActivity";
import { LiveActivity } from "@/components/chat/LiveActivity";
import { BusyRegion } from "@/components/ui/BusyRegion";
import { Spinner } from "@/components/ui/Spinner";
import { useServerState } from "@/components/ui/useRefresh";
import type {
  ProjectDelivery,
  ProjectRun,
  ProjectRunCard,
  ProjectRunStatus,
} from "@/types";
import { useTimeLabel } from "@/components/projects/useTimeLabel";

/**
 * One colour per run state, used for the badge, the progress bar and the
 * header edge so the state reads at a glance: green = working, amber = held
 * on a person, red = failed/blocked/stalled, blue = finished, grey = stopped.
 */
type StatusStyle = {
  label: string;
  badge: string;
  bar: string;
  edge: string;
  animated: boolean;
};

const RUN_STYLE: Record<ProjectRunStatus, StatusStyle> = {
  running: {
    label: "Running",
    badge: "bg-emerald-500/15 text-emerald-300 ring-emerald-400/40",
    bar: "bg-emerald-400",
    edge: "border-l-emerald-400",
    animated: true,
  },
  waiting: {
    label: "Waiting for you",
    badge: "bg-amber-500/15 text-[var(--color-warn-text)] ring-amber-400/40",
    bar: "bg-amber-400",
    edge: "border-l-amber-400",
    animated: false,
  },
  blocked: {
    label: "Blocked",
    badge: "bg-red-500/15 text-red-300 ring-red-400/40",
    bar: "bg-red-400",
    edge: "border-l-red-400",
    animated: false,
  },
  done: {
    label: "Done",
    badge: "bg-sky-500/15 text-sky-300 ring-sky-400/40",
    bar: "bg-sky-400",
    edge: "border-l-sky-400",
    animated: false,
  },
  failed: {
    label: "Failed",
    badge: "bg-red-500/20 text-red-300 ring-red-400/60",
    bar: "bg-red-500",
    edge: "border-l-red-500",
    animated: false,
  },
  cancelled: {
    label: "Stopped",
    badge: "bg-[var(--color-surface-2)] text-[var(--color-muted)] ring-[var(--color-border)]",
    bar: "bg-[var(--color-muted)]",
    edge: "border-l-[var(--color-border)]",
    animated: false,
  },
};

const STALLED_STYLE: StatusStyle = {
  label: "Stalled",
  badge: "bg-red-500/15 text-red-300 ring-red-400/40",
  bar: "bg-red-400",
  edge: "border-l-red-400",
  animated: false,
};

/** Board column → colour + plain words for a card row. */
const CARD_STYLE: Record<string, { dot: string; label: string; animated?: boolean }> = {
  running: { dot: "bg-emerald-400", label: "working", animated: true },
  ready: { dot: "bg-emerald-400/50", label: "queued — a worker picks it up next" },
  todo: { dot: "bg-amber-400/70", label: "waiting on an earlier step" },
  triage: { dot: "bg-amber-400", label: "held — released on Continue" },
  blocked: { dot: "bg-red-400", label: "blocked — needs you" },
  done: { dot: "bg-sky-400", label: "done" },
  archived: { dot: "bg-[var(--color-muted)]", label: "stopped" },
};

function cardStyle(status: string | null) {
  return (
    CARD_STYLE[status ?? ""] ?? {
      dot: "bg-[var(--color-muted)]",
      label: status ?? "unknown",
    }
  );
}

function RunStatusBadge({
  style,
  live,
}: {
  style: StatusStyle;
  live: boolean;
}) {
  return (
    <span
      data-component="RunStatusBadge"
      role="status"
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${style.badge}`}
    >
      {style.animated && live ? (
        <span className="relative flex h-2 w-2" aria-hidden="true">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-current" />
        </span>
      ) : (
        <span
          className="inline-block h-2 w-2 rounded-full bg-current"
          aria-hidden="true"
        />
      )}
      {style.label}
    </span>
  );
}

function RunProgress({
  percent,
  style,
  live,
  cards,
}: {
  percent: number;
  style: StatusStyle;
  live: boolean;
  cards: ProjectRunCard[];
}) {
  const done = cards.filter((c) => c.status === "done").length;
  const working = cards.filter((c) => c.status === "running").length;
  return (
    <div data-component="RunProgress" className="mt-3">
      <div className="flex items-center justify-between text-xs">
        <span className="flex items-center gap-1.5 text-[var(--color-muted)]">
          {live && style.animated ? <Spinner className="text-emerald-300" /> : null}
          {cards.length > 0
            ? `${done} of ${cards.length} step${cards.length === 1 ? "" : "s"} done${
                working > 0 ? ` · ${working} working` : ""
              }`
            : live
              ? "Working…"
              : "No steps on this run"}
        </span>
        <span className="font-semibold tabular-nums">{percent}%</span>
      </div>
      <div
        className="mt-1 h-2 w-full overflow-hidden rounded-full bg-[var(--color-surface-2)]"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label="Run completion"
      >
        <div
          className={`h-full rounded-full transition-[width] duration-700 ${style.bar} ${
            live && style.animated ? "animate-pulse" : ""
          }`}
          style={{ width: `${Math.max(percent, live ? 2 : 0)}%` }}
        />
      </div>
    </div>
  );
}

function completionOf(run: ProjectRun, cards: ProjectRunCard[]): number {
  if (typeof run.completion_percent === "number") return run.completion_percent;
  if (run.status === "done") return 100;
  if (cards.length === 0) return 0;
  const total = cards.reduce(
    (sum, c) => sum + (c.status === "done" ? 1 : c.status === "running" ? 0.5 : 0),
    0,
  );
  return Math.round((100 * total) / cards.length);
}

function deliveryLabel(delivery: ProjectDelivery): string {
  const what = delivery.label ?? delivery.link_ref ?? "an artefact";
  const how =
    delivery.run_id != null
      ? "on a run"
      : delivery.task_id != null
        ? "from a card"
        : "by hand";
  return `${what} — delivered ${how}`;
}

type RunControl = "continue" | "cancel" | "stop" | "resume" | "repeat";

/**
 * One run's page (§7): what it did — cards, deliveries, cost, outcome — and
 * the two things a human writes about it afterwards, the retro and (step 9b)
 * the score. Continue passes a checkpoint; Cancel stops promoting and lets a
 * running card finish; "Stop now" terminates the live workers and closes the
 * run; "Repeat this run" starts a new one on the same method.
 *
 * While the run is live it also shows what the run is *thinking* — the
 * agent's reasoning and its tool calls, streamed — for the run's inline
 * steps. A board-dispatched card runs in another process and is not visible
 * that way; the panel says so rather than reading as an idle run.
 */
export function RunView({
  slug,
  run: initial,
  archived = false,
}: {
  slug: string;
  run: ProjectRun;
  archived?: boolean;
}) {
  const timeLabel = useTimeLabel();
  const router = useRouter();
  const [run, setRun] = useServerState(initial);
  // Run controls share one lock (one move at a time on a run); the retro and
  // the score are separate writes with their own.
  const control = useProjectAction<Record<string, unknown>>();
  const [controlling, setControlling] = useState<RunControl | null>(null);
  const retroAction = useProjectAction();
  const scoreAction = useProjectAction();
  const [navigating, startNavigation] = useTransition();
  const busy = control.busy || retroAction.busy || scoreAction.busy || navigating;
  const [budgetGate, setBudgetGate] = useState<string | null>(null);
  const [retroDraft, setRetroDraft] = useState(initial.retro ?? "");
  const [retroSaved, setRetroSaved] = useState(false);
  const [scoreDraft, setScoreDraft] = useState<number | null>(
    initial.score_user ?? null,
  );
  const [scoreNote, setScoreNote] = useState(initial.score_note ?? "");
  const [scoreSaved, setScoreSaved] = useState(false);

  const slugPath = `/api/projects/${encodeURIComponent(slug)}`;
  const runPath = `${slugPath}/runs/${run.run_no}`;

  // A terminal row (e.g. auto-failed by the stale-run sweep) can still have
  // a card actively working — a human can unblock/resume the underlying
  // card without the run row reopening in the same instant. Keep polling
  // in that case so the page doesn't freeze on a stale "Failed" banner
  // while real work finishes (found confusing in production).
  const hasActiveCard = (run.cards ?? []).some((c) => c.status === "running");

  // While the run is still moving, re-read it: the server derives the cards'
  // board state, the blocked set, `stalled`, cost and duration on read, so a
  // person watching the page sees the run move without reloading it.
  useRunLive(
    slug,
    run.run_no,
    run.status,
    (fresh) => setRun((prev) => ({ ...prev, ...fresh })),
    hasActiveCard,
  );

  /** Continue/cancel/stop/resume answer with the updated run row; merge it in. */
  const mergeUpdatedRun = (data: Record<string, unknown>) => {
    // Continue answers with {run, promoted, budget_gate}; cancel with
    // the bare run row. Unwrap whichever came back.
    const { run: updated, budgetGate } = unwrapRunEnvelope(data);
    // The bare row carries no derived flags; the hold is answered now.
    if (updated) {
      setRun((prev) => ({ ...prev, awaiting_continue: false, ...updated }));
    }
    // The thing holding the run must be visible, not silent.
    setBudgetGate(budgetGate);
  };

  const steer = (which: Exclude<RunControl, "repeat">) => {
    if (control.busy) return;
    setControlling(which);
    void control.run(`${runPath}/${which}`, { onSuccess: mergeUpdatedRun });
  };

  const repeat = () => {
    if (control.busy) return;
    setControlling("repeat");
    void control.run(`${slugPath}/runs`, {
      body: run.playbook_rev != null ? { playbook_rev: run.playbook_rev } : {},
      skipRefresh: true,
      onSuccess: () =>
        startNavigation(() => router.push(`/projects/${encodeURIComponent(slug)}`)),
    });
  };

  const saveRetro = () => {
    const text = retroDraft.trim();
    if (!text) return;
    setRetroSaved(false);
    void retroAction.run(`${runPath}/retro`, {
      body: { retro: text },
      onSuccess: () => {
        setRun((prev) => ({ ...prev, retro: text }));
        setRetroSaved(true);
      },
    });
  };

  /** §8.1: the human judgement — one tap, editable, never the agent's. */
  const saveScore = () => {
    if (scoreDraft == null) return;
    setScoreSaved(false);
    const note = scoreNote.trim();
    const body: Record<string, unknown> = { score: scoreDraft };
    if (note) body.note = note;
    const score = scoreDraft;
    void scoreAction.run(`${runPath}/score`, {
      body,
      onSuccess: () => {
        setRun((prev) => ({ ...prev, score_user: score, score_note: note || null }));
        setScoreSaved(true);
      },
    });
  };
  const controlPending = (which: RunControl) =>
    (control.busy || (which === "repeat" && navigating)) && controlling === which;

  const deliveries = Array.isArray(run.deliveries) ? run.deliveries : [];
  const cards = run.cards ?? [];
  const blockedTasks = run.blocked_tasks ?? [];
  const live =
    run.status === "running" ||
    run.status === "waiting" ||
    run.status === "blocked";
  // The row says running but the server saw no worker behind it — say so.
  const stalled = run.status === "running" && run.stalled === true;
  // Held on the human: a budget/checkpoint `waiting` row, or a supervised
  // run whose checkpoint card finished while its successors wait in triage.
  const canContinue =
    !archived &&
    (run.status === "waiting" || (live && run.awaiting_continue === true));
  // A stopped run whose cards can pick up where they left off — the answer
  // to "the automatic recovery gave up but the work already done is still
  // good," as distinct from Repeat (a brand-new run, same method, redoes
  // every step from scratch).
  const canResume =
    !archived && (run.status === "failed" || run.status === "cancelled");
  const activity = useRunActivity(slug, run.run_no, live);
  const style = stalled ? STALLED_STYLE : RUN_STYLE[run.status];
  const percent = completionOf(run, cards);
  const retried = cards.filter((c) => (c.failed_attempts ?? 0) > 0);
  const blockedCard = cards.find((c) => c.status === "blocked");
  const triageCard = cards.find((c) => c.status === "triage");

  // One clear, plain-English line: what's happening, what to do about it if
  // anything, ranked by how urgent it is. Rendered above every other banner
  // so a person never has to piece the state together from several signals
  // at once — the confusion a real run's "Failed" badge caused in
  // production while a card kept working underneath it.
  const nextAction = ((): {
    tone: "action" | "attention" | "ok";
    text: string;
    /** The checkpoint/blocked card's own words, quoted verbatim — the
     * whole point being a person doesn't have to click through to find
     * out what it's actually waiting on. */
    detail?: string;
    href?: string;
    hrefLabel?: string;
    /** The successor card(s) a checkpoint hold is keeping in triage —
     * where to actually add answers (Edit card → brief), before tapping
     * Continue below. */
    heldCards?: { task_id: string; title: string | null }[];
  } | null => {
    if (canContinue) {
      const wait = run.checkpoint_wait;
      return {
        tone: "action",
        text: wait?.checkpoint_title
          ? `"${wait.checkpoint_title}" is done and waiting on your review before its next step(s) proceed.`
          : "Review the checkpoint step's work below, then tap Continue to release the next step(s).",
        detail: wait?.comment ?? undefined,
        href: wait?.checkpoint_task_id
          ? `/projects/${encodeURIComponent(slug)}/cards/${encodeURIComponent(wait.checkpoint_task_id)}`
          : undefined,
        hrefLabel: "Open the checkpoint card",
        heldCards: wait?.held_task_ids?.length
          ? cards.filter((c) => wait.held_task_ids.includes(c.task_id))
          : undefined,
      };
    }
    if (canResume) {
      return hasActiveCard
        ? {
            tone: "attention",
            text: 'This run is marked "Failed", but a card is still actively working — the board below is live and up to date. Tap Resume once it settles to formally reopen the run, or just watch it finish.',
          }
        : {
            tone: "action",
            text: "This run stopped before finishing. Tap Resume to continue from exactly where it left off — nothing already done gets redone. \u201cStart over\u201d instead runs the whole method again from scratch.",
          };
    }
    const humanWait = live ? run.waiting_on_you?.[0] : undefined;
    if (humanWait) {
      return {
        tone: "action",
        text: humanWait.parked
          ? `"${humanWait.title ?? humanWait.task_id}" was ${parkedText(humanWait)}. It won't be restarted automatically — review the revised plan, or answer the card and re-run it.`
          : `"${humanWait.title ?? humanWait.task_id}" is waiting on you. This run continues once you answer or unblock it; scheduled runs are skipped until then.`,
        detail: humanWait.reason ?? undefined,
        href: `/projects/${encodeURIComponent(slug)}/cards/${encodeURIComponent(humanWait.task_id)}`,
        hrefLabel: "Open the card",
      };
    }
    if (stalled) {
      return {
        tone: "attention",
        text: "This run says Running, but no worker is actually active on it — it has stalled. Cancel or Stop it below, or open the blocked work to retry it.",
      };
    }
    if (blockedCard) {
      return {
        tone: "attention",
        text: `"${blockedCard.title ?? blockedCard.task_id}" is blocked and needs you — open it below to see why and what to do.`,
      };
    }
    if (triageCard && live) {
      return {
        tone: "attention",
        text: `"${triageCard.title ?? triageCard.task_id}" needs a decision after repeated retries — open it below to review.`,
      };
    }
    if (run.status === "done") {
      return {
        tone: "ok",
        text: "This run finished. Review what it delivered below, then score it.",
      };
    }
    const replanned = run.replanned?.[run.replanned.length - 1];
    if (live && replanned && run.status === "running") {
      return {
        tone: "ok",
        text: `Re-planned automatically after "${replanned.title ?? replanned.task_id}" parked — this run continues on plan revision ${replanned.rev ?? "?"}.`,
      };
    }
    if (live) {
      return {
        tone: "ok",
        text:
          run.status === "running"
            ? "Working — no action needed right now."
            : "Waiting on the next step.",
      };
    }
    return null;
  })();

  return (
    <div data-component="RunView" className="flex flex-col gap-4">
      <BusyRegion busy={busy} label={busy ? "Talking to the agent…" : undefined}>
        <div className="flex flex-col gap-4">
          {/* ── Headline ──────────────────────────────────────────── */}
          <header
            data-component="RunHeader"
            className={`rounded-2xl border border-l-4 border-[var(--color-border)] bg-[var(--color-surface)] p-4 ${style.edge}`}
          >
            <div className="flex items-center gap-2">
              <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">
                Run #{run.run_no}
              </h1>
              <RunStatusBadge style={style} live={live && !stalled} />
            </div>
            <RunProgress
              percent={percent}
              style={style}
              live={live && !stalled}
              cards={cards}
            />
            {nextAction ? (
              <div
                data-component="NextAction"
                role="status"
                className={`mt-2 rounded-lg border px-3 py-2 text-sm ${
                  nextAction.tone === "action"
                    ? "border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10"
                    : nextAction.tone === "attention"
                      ? "border-amber-500/40 bg-amber-500/10 text-[var(--color-warn-text)]"
                      : "border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-muted)]"
                }`}
              >
                <p>
                  <span className="font-medium">
                    {nextAction.tone === "action"
                      ? "Next: "
                      : nextAction.tone === "attention"
                        ? "Needs attention: "
                        : ""}
                  </span>
                  {nextAction.text}
                </p>
                {nextAction.detail ? (
                  <p className="mt-1.5 whitespace-pre-wrap border-l-2 border-current/30 pl-2 text-[var(--color-muted)]">
                    {nextAction.detail}
                  </p>
                ) : null}
                {nextAction.href ? (
                  <Link
                    href={nextAction.href}
                    className="mt-1.5 inline-block underline"
                  >
                    {nextAction.hrefLabel ?? "Open"}
                  </Link>
                ) : null}
                {nextAction.heldCards?.length ? (
                  <div className="mt-1.5">
                    <p className="text-xs">
                      To add your answer before tapping Continue, open the
                      held step below and edit its brief:
                    </p>
                    <ul className="mt-1 flex flex-col gap-1">
                      {nextAction.heldCards.map((c) => (
                        <li key={c.task_id}>
                          <Link
                            href={`/projects/${encodeURIComponent(slug)}/cards/${encodeURIComponent(c.task_id)}`}
                            className="underline"
                          >
                            {c.title ?? c.task_id}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            ) : null}
            <p className="mt-1 text-xs text-[var(--color-muted)]">
              {run.trigger} · on {run.profile} · started{" "}
              {timeLabel(run.started_at)} ·{" "}
              {durationLabel(run.duration_seconds)}
              {run.playbook_rev != null ? ` · plan rev ${run.playbook_rev}` : ""}
            </p>
            <p className="mt-1 text-xs text-[var(--color-muted)]">
              cost:{" "}
              {run.cost != null
                ? `$${run.cost.toFixed(2)}`
                : run.cost_recorded === false
                  ? "not recorded"
                  : "—"}
            </p>
            {run.outcome ? (
              <p className="mt-2 text-sm">{run.outcome}</p>
            ) : null}
            {run.summary ? (
              <p className="mt-1 text-sm text-[var(--color-muted)]">
                {run.summary}
              </p>
            ) : null}
            {run.error ? (
              <p className="mt-1 text-sm text-[var(--color-danger)]">{run.error}</p>
            ) : null}
            {run.score_user != null || run.score_self != null ? (
              <p className="mt-2 text-xs text-[var(--color-muted)]">
                score:
                {run.score_user != null ? ` ${run.score_user}/5 (you)` : ""}
                {run.score_self != null ? ` · ${run.score_self}/5 (self)` : ""}
                {run.score_note ? ` — ${run.score_note}` : ""}
              </p>
            ) : null}

            <div className="mt-3 flex flex-wrap gap-2">
              {canContinue ? (
                <ActionButton
                  busy={controlPending("continue")}
                  pendingLabel="Continuing…"
                  onClick={() => steer("continue")}
                  disabled={busy}
                  className="rounded-xl bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-50"
                >
                  Continue
                </ActionButton>
              ) : null}
              {live ? (
                <ActionButton
                  busy={controlPending("cancel")}
                  pendingLabel="Cancelling…"
                  onClick={() => steer("cancel")}
                  disabled={busy}
                  className="rounded-xl border border-red-500/50 px-4 py-2 text-sm text-red-400 disabled:opacity-50"
                >
                  Cancel
                </ActionButton>
              ) : null}
              {live ? (
                <ActionButton
                  busy={controlPending("stop")}
                  pendingLabel="Stopping…"
                  onClick={() => {
                    if (
                      !window.confirm(
                        "Stop this run now? Work in progress is terminated where it stands — Cancel instead lets a running card finish.",
                      )
                    ) {
                      return;
                    }
                    steer("stop");
                  }}
                  disabled={busy}
                  className="rounded-xl bg-red-500/90 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  Stop now
                </ActionButton>
              ) : null}
              {canResume ? (
                <ActionButton
                  busy={controlPending("resume")}
                  pendingLabel="Resuming…"
                  onClick={() => steer("resume")}
                  disabled={busy}
                  className="rounded-xl bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-50"
                >
                  Resume
                </ActionButton>
              ) : null}
              {(!live || stalled) && !archived ? (
                <ActionButton
                  busy={controlPending("repeat")}
                  pendingLabel="Starting run…"
                  onClick={() => {
                    if (
                      canResume &&
                      !window.confirm(
                        "Start a brand-new run on the same method? This redoes every step from scratch, including ones already done — Resume instead continues from exactly where this run left off.",
                      )
                    ) {
                      return;
                    }
                    repeat();
                  }}
                  disabled={busy}
                  className={
                    canResume
                      ? "rounded-xl border border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-muted)] disabled:opacity-50"
                      : "rounded-xl border border-[var(--color-border)] px-4 py-2 text-sm disabled:opacity-50"
                  }
                >
                  {canResume ? "Start over instead" : "Repeat this run"}
                </ActionButton>
              ) : null}
            </div>

            {retried.length > 0 ? (
              <div
                data-component="RetryBanner"
                role="status"
                className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-[var(--color-warn-text)]"
              >
                <p>
                  {retried.length === 1
                    ? "One step crashed and was retried"
                    : `${retried.length} steps crashed and were retried`}
                  {live ? " — the run kept going." : "."}
                </p>
                <ul className="mt-1 flex flex-col gap-0.5 text-xs">
                  {retried.map((c) => (
                    <li key={c.task_id} className="truncate">
                      <span className="font-medium">{c.title ?? c.task_id}</span>
                      {" — attempt "}
                      {c.attempts ?? 0}
                      {c.last_error ? `: ${c.last_error}` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {stalled ? (
              <p
                data-component="StallBanner"
                role="status"
                className="mt-2 rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-sm text-[var(--color-warn-text)]"
              >
                Marked running, but no worker is active on this run — it is
                stalled. Cancel stops it; retry the blocked work below;
                Repeat starts a fresh run on the same method.
              </p>
            ) : null}

            {live ? (
              <div data-component="RunActivity" className="mt-3">
                <p className="text-xs font-medium text-[var(--color-muted)]">
                  What this run is doing
                </p>
                {activity.unavailable ? (
                  <p className="mt-1 text-xs text-[var(--color-muted)]">
                    A worker is on it, in its own process — its reasoning is
                    not streamed here. Watch the steps below: the green dot
                    is the one being worked on, and the bar above fills as
                    steps finish. Open a step to see its log and comments.
                  </p>
                ) : activity.reasoning === "" &&
                  activity.tools.length === 0 ? (
                  <p className="mt-1 text-xs text-[var(--color-muted)]">
                    Waiting for the first thing it says&hellip;
                  </p>
                ) : (
                  <LiveActivity
                    reasoning={activity.reasoning}
                    tools={activity.tools}
                  />
                )}
              </div>
            ) : null}

            {archived ? (
              <p className="mt-3 text-xs text-[var(--color-muted)]">
                This project is archived — restore it (⋯) to continue or
                score this run.
              </p>
            ) : null}

            <ActionError action={control} />
            {budgetGate ? (
              <p
                data-component="BudgetGate"
                role="status"
                className="mt-2 rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-sm text-[var(--color-warn-text)]"
              >
                {budgetGate}
              </p>
            ) : null}
          </header>

          {/* ── Cards ─────────────────────────────────────────────── */}
          <section
            data-component="RunCards"
            className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
          >
            <h2 className="text-xs uppercase tracking-wide text-[var(--color-muted)]">
              Cards
            </h2>
            {cards.length === 0 ? (
              <p className="mt-2 text-sm text-[var(--color-muted)]">
                This run worked without cards.
              </p>
            ) : (
              <ul className="mt-2 flex flex-col gap-1.5">
                {cards.map((card) => {
                  const cs = cardStyle(card.status);
                  const failed = card.failed_attempts ?? 0;
                  return (
                    <li key={card.task_id}>
                      <Link
                        href={`/projects/${encodeURIComponent(slug)}/cards/${encodeURIComponent(card.task_id)}`}
                        data-status={card.status ?? "unknown"}
                        className="flex items-center gap-2.5 rounded-lg bg-[var(--color-surface-2)] px-3 py-2 text-sm active:opacity-70"
                      >
                        <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden="true">
                          {cs.animated && live ? (
                            <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${cs.dot}`} />
                          ) : null}
                          <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${cs.dot}`} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">
                            {card.title ?? card.task_id}
                          </span>
                          <span className="block truncate text-xs text-[var(--color-muted)]">
                            {card.step_key ? `${card.step_key} · ` : ""}
                            {cs.label}
                            {failed > 0
                              ? ` · attempt ${card.attempts ?? failed + 1}, ${failed} crashed`
                              : ""}
                          </span>
                        </span>
                        {card.status === "running" && live ? (
                          <Spinner className="text-emerald-300" />
                        ) : null}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* ── Blocked work ──────────────────────────────────────── */}
          {blockedTasks.length > 0 ? (
            <section
              data-component="RunBlocked"
              className="rounded-2xl border border-red-500/30 bg-[var(--color-surface)] p-4"
            >
              <h2 className="text-xs uppercase tracking-wide text-[var(--color-danger)]">
                Blocked work
              </h2>
              <p className="mt-1 text-xs text-[var(--color-muted)]">
                These stopped the run. Open one to retry or stop it.
              </p>
              <ul className="mt-2 flex flex-col gap-1.5">
                {blockedTasks.map((task) => (
                  <li key={task.task_id}>
                    <Link
                      href={`/projects/${encodeURIComponent(slug)}/cards/${encodeURIComponent(task.task_id)}`}
                      className="block rounded-lg bg-[var(--color-surface-2)] px-3 py-2 text-sm active:opacity-70"
                    >
                      <span className="block truncate">
                        {task.title ?? task.task_id}
                      </span>
                      {task.error ? (
                        <span className="block truncate text-xs text-[var(--color-danger)]">
                          {task.error}
                        </span>
                      ) : null}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {/* ── Deliveries ────────────────────────────────────────── */}
          <section
            data-component="RunDeliveries"
            className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
          >
            <h2 className="text-xs uppercase tracking-wide text-[var(--color-muted)]">
              Delivered
            </h2>
            {deliveries.length === 0 ? (
              <p className="mt-2 text-sm text-[var(--color-muted)]">
                Nothing was delivered on this run.
              </p>
            ) : (
              <ul className="mt-2 flex flex-col gap-1.5">
                {deliveries.map((delivery) => (
                  <li
                    key={delivery.id}
                    className="rounded-lg bg-[var(--color-surface-2)] px-3 py-2 text-sm"
                  >
                    {deliveryLabel(delivery)}
                    <span className="ml-2 text-xs text-[var(--color-muted)]">
                      {timeLabel(delivery.delivered_at)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* ── Retro ─────────────────────────────────────────────── */}
          <section
            data-component="RunRetro"
            className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
          >
            <h2 className="text-xs uppercase tracking-wide text-[var(--color-muted)]">
              Retrospective
            </h2>
            <textarea
              className="mt-2 min-h-24 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm"
              placeholder="What worked, what didn't, what to change next time…"
              readOnly={archived}
              value={retroDraft}
              onChange={(e) => {
                setRetroDraft(e.target.value);
                setRetroSaved(false);
              }}
            />
            {!archived ? (
              <div className="mt-2 flex items-center gap-2">
                <ActionButton
                  busy={retroAction.busy}
                  pendingLabel="Saving…"
                  onClick={saveRetro}
                  disabled={busy || !retroDraft.trim()}
                  className="rounded-xl bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-50"
                >
                  Save retro
                </ActionButton>
                {retroSaved ? (
                  <span className="text-xs text-[var(--color-muted)]">saved</span>
                ) : null}
              </div>
            ) : null}
            {!archived ? (
              <ActionError action={retroAction} />
            ) : null}
          </section>
          {/* ── Score ────────────────────────────────────────────── */}
          <section
            data-component="RunScore"
            className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
          >
            <h2 className="text-xs uppercase tracking-wide text-[var(--color-muted)]">
              Your score
            </h2>
            {!archived ? (
              <>
                <div
                  className="mt-2 flex gap-1.5"
                  role="group"
                  aria-label="Score this run from 1 to 5"
                >
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => {
                        setScoreDraft(n);
                        setScoreSaved(false);
                      }}
                      disabled={busy}
                      aria-pressed={scoreDraft === n}
                      className={`h-9 w-9 rounded-xl border text-sm disabled:opacity-50 ${
                        scoreDraft === n
                          ? "border-[var(--color-accent)] bg-[var(--color-accent)] font-medium text-[var(--color-accent-fg)]"
                          : "border-[var(--color-border)] bg-[var(--color-surface-2)]"
                      }`}
                    >
                      {n}
                    </button>
                  ))}
                </div>
                <input
                  className="mt-2 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-sm"
                  placeholder="One line on why — optional"
                  value={scoreNote}
                  onChange={(e) => {
                    setScoreNote(e.target.value);
                    setScoreSaved(false);
                  }}
                />
                <div className="mt-2 flex items-center gap-2">
                  <ActionButton
                    busy={scoreAction.busy}
                    pendingLabel="Saving…"
                    onClick={saveScore}
                    disabled={busy || scoreDraft == null}
                    className="rounded-xl bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-50"
                  >
                    Save score
                  </ActionButton>
                  {scoreSaved ? (
                    <span className="text-xs text-[var(--color-muted)]">
                      saved
                    </span>
                  ) : null}
                </div>
                <ActionError action={scoreAction} />
              </>
            ) : null}
          </section>
        </div>
      </BusyRegion>
    </div>
  );
}
