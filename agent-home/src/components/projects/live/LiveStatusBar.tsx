"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { ActionButton } from "@/components/projects/ActionButton";
import { useCardActivity } from "@/components/projects/useCardActivity";
import { useCardLive } from "@/components/projects/useCardLive";
import { useProjectAction } from "@/components/projects/useProjectAction";
import { useRunActivity } from "@/components/projects/useRunActivity";
import { useRunLive } from "@/components/projects/useRunLive";
import type { ToolChip } from "@/components/chat/LiveActivity";
import type {
  ProjectBoardView,
  ProjectCardDetail,
  ProjectDetail,
  ProjectRun,
} from "@/types";

import {
  elapsedLabel,
  lastLines,
  liveState,
  openRunOf,
  progressSegments,
  silenceLevel,
  startedAgo,
  type LiveState,
  type LiveTask,
  type StopMode,
  type StopRequest,
} from "./liveState";
import { useHydrated } from "@/lib/use-hydrated";

/** Scrolled past this many pixels, the bar folds to one line. */
export const COLLAPSE_AFTER_PX = 160;

export const NO_REASONING = "live reasoning not available for this task";

const STOP_BTN =
  "rounded-xl border border-red-500 px-3 py-1.5 text-sm font-semibold text-red-500 disabled:opacity-50";
const PRIMARY_BTN =
  "rounded-xl bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] disabled:opacity-50";
const GHOST_BTN =
  "rounded-xl border border-[var(--color-border)] px-3 py-1.5 text-sm disabled:opacity-50";

/** Seconds since epoch, ticking; `null` on the server and while hydrating (no #418). */
function useNow(): number | null {
  const hydrated = useHydrated();
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(id);
  }, []);
  return hydrated ? now : null;
}

function useScrolledPast(px: number): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > px);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [px]);
  return scrolled;
}

function StateDot({ kind }: { kind: LiveState["kind"] }) {
  if (kind === "working") {
    return (
      <span aria-hidden data-dot="pulse" className="relative flex h-3 w-3 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
        <span className="relative inline-flex h-3 w-3 rounded-full bg-emerald-500" />
      </span>
    );
  }
  const colour =
    kind === "stalled"
      ? "bg-red-500"
      : kind === "needs_you"
        ? "bg-amber-400"
        : kind === "stopping"
          ? "bg-amber-400 animate-pulse"
          : "bg-[var(--color-muted)]";
  return <span aria-hidden className={`inline-block h-3 w-3 shrink-0 rounded-full ${colour}`} />;
}

const LABEL_COLOUR: Partial<Record<LiveState["kind"], string>> = {
  stalled: "text-red-500",
  needs_you: "text-[var(--color-warn-text)]",
};

function ToolChips({ tools }: { tools: ToolChip[] }) {
  if (tools.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {tools.map((t, i) => (
        <span
          key={`${t.id}-${i}`}
          data-tool={t.done ? "done" : "running"}
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${
            t.done
              ? "bg-[var(--color-surface-2)] text-[var(--color-muted)]"
              : "bg-[var(--color-accent)]/15 text-[var(--color-accent)]"
          }`}
        >
          {t.done ? (
            <span aria-hidden>✓</span>
          ) : (
            <span
              aria-hidden
              className="inline-block h-2.5 w-2.5 animate-spin rounded-full border-2 border-current border-r-transparent"
            />
          )}
          {t.name}
        </span>
      ))}
    </div>
  );
}

function ReasoningBox({
  lines,
  live,
  fallback,
}: {
  lines: string[];
  live: boolean;
  fallback: string | null;
}) {
  return (
    <div
      data-component="LiveReasoning"
      className="mt-2 flex h-[76px] flex-col justify-end overflow-hidden rounded-xl bg-[var(--color-surface-2)] px-2.5 py-2 text-xs italic leading-snug text-[var(--color-muted)]"
    >
      {lines.length > 0 ? (
        lines.map((line, i) => (
          <div key={`${i}-${line}`} className="truncate">
            {line}
            {live && i === lines.length - 1 ? (
              <span aria-hidden className="ml-0.5 animate-pulse not-italic text-[var(--color-accent)]">
                ▍
              </span>
            ) : null}
          </div>
        ))
      ) : (
        <>
          {fallback ? <div className="line-clamp-2 not-italic">{fallback}</div> : null}
          <div data-reasoning="unavailable">{NO_REASONING}</div>
        </>
      )}
    </div>
  );
}

function RowMeta({
  parts,
  silentFor,
}: {
  parts: string[];
  silentFor: number | null;
}) {
  const level = silenceLevel(silentFor);
  const tone =
    level === "silent" ? "text-red-500 font-medium" : level === "quiet" ? "text-[var(--color-warn-text)] font-medium" : "";
  return (
    <div className="truncate text-xs text-[var(--color-muted)]">
      {parts.filter(Boolean).join(" · ")}
      {silentFor != null ? (
        <>
          {" · "}
          <span data-silence={level} className={tone}>
            last update {elapsedLabel(silentFor)} ago
          </span>
        </>
      ) : null}
    </div>
  );
}

function Avatar() {
  return (
    <span
      aria-hidden
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent)] text-xs font-semibold text-[var(--color-accent-fg)]"
    >
      A
    </span>
  );
}

/** Pure: the fallback note when a worker publishes no reasoning. */
export function fallbackNote(card: ProjectCardDetail | null): string | null {
  if (!card) return null;
  if (card.latest_heartbeat?.note) return card.latest_heartbeat.note;
  const comments = card.comments ?? [];
  const last = comments[comments.length - 1];
  return last?.body ?? null;
}

/** Pure: the newest moment anything was heard from a task, epoch seconds. */
export function lastHeardAt(
  activityAt: number | null,
  card: ProjectCardDetail | null,
  startedAt: number | null,
): number | null {
  const comments = card?.comments ?? [];
  const candidates = [
    activityAt,
    card?.latest_heartbeat?.created_at ?? null,
    comments[comments.length - 1]?.created_at ?? null,
    startedAt,
  ].filter((v): v is number => typeof v === "number");
  return candidates.length > 0 ? Math.max(...candidates) : null;
}

function TaskRow({
  slug,
  task,
  now,
  stopped,
  canStop,
  onStopped,
}: {
  slug: string;
  task: LiveTask;
  now: number | null;
  stopped: boolean;
  canStop: boolean;
  onStopped: (task: LiveTask) => void;
}) {
  const live = !stopped;
  const activity = useCardActivity(slug, task.id, live);
  const [card, setCard] = useState<ProjectCardDetail | null>(null);
  useCardLive(slug, task.id, live ? "running" : "stopped", setCard);
  const stop = useProjectAction();
  const heard = lastHeardAt(activity.lastAt, card, task.startedAt);
  const lines = lastLines(activity.reasoning, 4);
  const href = `/projects/${encodeURIComponent(slug)}/cards/${encodeURIComponent(task.id)}`;

  return (
    <div
      data-component="LiveTaskRow"
      data-task-id={task.id}
      data-stopped={stopped ? "true" : undefined}
      className={`min-w-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5 ${stopped ? "opacity-60" : ""}`}
    >
      <div className="flex items-center gap-2">
        <Avatar />
        <div className="min-w-0 flex-1">
          <b className="block truncate text-sm">{task.title}</b>
          <RowMeta
            parts={[
              task.stepIndex != null && task.stepTotal != null
                ? `step ${task.stepIndex} of ${task.stepTotal}`
                : "",
              task.profile ? `worker on ${task.profile}` : "",
              task.startedAt != null && now != null ? elapsedLabel(now - task.startedAt) : "",
            ]}
            silentFor={stopped || heard == null || now == null ? null : Math.max(0, now - heard)}
          />
        </div>
        <Link href={href} className="shrink-0 rounded-lg px-2 py-1 text-xs text-[var(--color-accent)]">
          Open ›
        </Link>
        {stopped ? (
          <span data-component="StoppedPill" className="shrink-0 rounded-full bg-[var(--color-surface-2)] px-2 py-0.5 text-xs">
            ■ Stopped by you
          </span>
        ) : canStop ? (
          <ActionButton
            busy={stop.busy}
            pendingLabel="Stopping…"
            className={`shrink-0 ${STOP_BTN} px-2 py-1 text-xs`}
            onClick={() =>
              void stop.run(`/api/projects/${encodeURIComponent(slug)}/cards/${encodeURIComponent(task.id)}/stop`, {
                onSuccess: () => onStopped(task),
              })
            }
          >
            ■ Stop
          </ActionButton>
        ) : null}
      </div>
      {stop.error ? (
        <p role="alert" className="mt-1 text-xs text-red-500">
          {stop.error}{" "}
          <button type="button" className="underline" disabled={stop.busy} onClick={() => void stop.retry()}>
            Try again
          </button>
        </p>
      ) : null}
      <ReasoningBox
        lines={lines}
        live={live && !activity.ended}
        fallback={activity.reasoning ? null : fallbackNote(card)}
      />
      <ToolChips tools={activity.tools} />
    </div>
  );
}

function InlineRow({
  slug,
  runNo,
  profile,
  startedAt,
  now,
  reasoning,
  tools,
}: {
  slug: string;
  runNo: number;
  profile: string | null;
  startedAt: number | null;
  now: number | null;
  reasoning: string;
  tools: ToolChip[];
}) {
  return (
    <div
      data-component="LiveTaskRow"
      data-task-id={`run-${runNo}-inline`}
      className="min-w-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5"
    >
      <div className="flex items-center gap-2">
        <Avatar />
        <div className="min-w-0 flex-1">
          <b className="block truncate text-sm">Run {runNo} · inline steps</b>
          <RowMeta
            parts={[
              profile ? `on ${profile}` : "",
              startedAt != null && now != null ? elapsedLabel(now - startedAt) : "",
            ]}
            silentFor={null}
          />
        </div>
        <Link
          href={`/projects/${encodeURIComponent(slug)}/runs/${runNo}`}
          className="shrink-0 rounded-lg px-2 py-1 text-xs text-[var(--color-accent)]"
        >
          Open ›
        </Link>
      </div>
      <ReasoningBox lines={lastLines(reasoning, 4)} live fallback={null} />
      <ToolChips tools={tools} />
    </div>
  );
}

const STOP_COPY: Record<StopMode, { title: string; detail: string }> = {
  now: {
    title: "Stop now",
    detail: "Running workers are terminated immediately. Steps not started yet are dropped.",
  },
  finish: {
    title: "Finish current steps, then stop",
    detail: "The running steps complete and nothing new starts.",
  },
};

function StopAllDialog({
  runNo,
  runningCount,
  doneCount,
  busy,
  error,
  onConfirm,
  onRetry,
  onClose,
}: {
  runNo: number;
  runningCount: number;
  doneCount: number;
  busy: boolean;
  error: string | null;
  onConfirm: (mode: StopMode) => void;
  onRetry: () => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<StopMode>("now");
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="stop-all-title"
      data-component="StopAllDialog"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center"
    >
      <div className="w-full max-w-md rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-xl">
        <h2 id="stop-all-title" className="text-base font-semibold">
          Stop run {runNo}?
        </h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          {runningCount === 1 ? "1 task is running." : `${runningCount} tasks are running.`} Work already
          done ({doneCount === 1 ? "1 step" : `${doneCount} steps`}) is kept either way.
        </p>
        <div className="mt-3 flex flex-col gap-2" role="radiogroup">
          {(Object.keys(STOP_COPY) as StopMode[]).map((key) => (
            <label
              key={key}
              className={`flex cursor-pointer gap-2 rounded-xl border p-2.5 ${
                mode === key ? "border-[var(--color-accent)]" : "border-[var(--color-border)]"
              }`}
            >
              <input
                type="radio"
                name="stop-mode"
                value={key}
                checked={mode === key}
                disabled={busy}
                onChange={() => setMode(key)}
                className="mt-1"
              />
              <span>
                <b className="text-sm">{STOP_COPY[key].title}</b>
                <span className="block text-xs text-[var(--color-muted)]">{STOP_COPY[key].detail}</span>
              </span>
            </label>
          ))}
        </div>
        {error ? (
          <p role="alert" className="mt-2 text-sm text-red-500">
            {error}{" "}
            <button type="button" className="underline" disabled={busy} onClick={onRetry}>
              Try again
            </button>
          </p>
        ) : null}
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" className={GHOST_BTN} disabled={busy} onClick={onClose}>
            Keep running
          </button>
          <ActionButton
            busy={busy}
            pendingLabel={`Stopping run ${runNo}…`}
            className="rounded-xl bg-red-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            onClick={() => onConfirm(mode)}
          >
            Stop run {runNo}
          </ActionButton>
        </div>
      </div>
    </div>
  );
}

function PrimaryAction({
  state,
  slug,
  runnable,
  ownsNextStep,
  onStopAll,
  stopBusy,
}: {
  state: LiveState;
  slug: string;
  runnable: boolean;
  ownsNextStep: boolean;
  onStopAll: () => void;
  stopBusy: boolean;
}) {
  const action = useProjectAction();
  const base = `/api/projects/${encodeURIComponent(slug)}`;
  const p = state.primary;
  let button = null;
  if (p?.kind === "continue" && ownsNextStep) {
    button = (
      <ActionButton busy={action.busy} pendingLabel="Continuing…" className={PRIMARY_BTN}
        onClick={() => void action.run(`${base}/runs/${p.runNo}/continue`)}>
        Continue run {p.runNo}
      </ActionButton>
    );
  } else if (p?.kind === "close") {
    button = (
      <ActionButton busy={action.busy} pendingLabel="Closing…" className={STOP_BTN}
        onClick={() => void action.run(`${base}/runs/${p.runNo}/cancel`)}>
        ■ Close run {p.runNo}
      </ActionButton>
    );
  } else if (p?.kind === "start" && ownsNextStep) {
    button = (
      <ActionButton busy={action.busy} pendingLabel="Starting…" className={PRIMARY_BTN}
        disabled={!runnable}
        title={runnable ? undefined : "See the checklist above."}
        onClick={() => void action.run(`${base}/runs`)}>
        ▶ Start next iteration
      </ActionButton>
    );
  }
  const stopAll =
    state.canStopAll && state.runNo != null && p?.kind !== "close" ? (
      <ActionButton busy={stopBusy} pendingLabel="Stopping…" className={STOP_BTN} onClick={onStopAll}>
        ■ Stop all
      </ActionButton>
    ) : null;
  return (
    <>
      {p?.kind !== "stop_all" ? button : null}
      {stopAll}
      {action.error ? (
        <p role="alert" className="basis-full text-sm text-red-500">
          {action.error}{" "}
          <button type="button" className="underline" disabled={action.busy} onClick={() => void action.retry()}>
            Try again
          </button>
        </p>
      ) : null}
    </>
  );
}

function summaryLine(state: LiveState, project: ProjectDetail, now: number | null): string {
  const n = state.runNo;
  if (state.kind === "idle") {
    const last = project.runs[0];
    if (!last) return "No runs yet · nothing running";
    return `Run ${last.run_no} ${last.status === "done" ? "finished" : last.status} · nothing running`;
  }
  const count = state.running.length + (state.inlineRunning ? 1 : 0);
  const parts = [
    n != null ? `Run ${n}` : "",
    state.kind === "stalled"
      ? "nothing is running"
      : state.kind === "needs_you"
        ? "waiting on you"
        : count === 1
          ? "1 task running"
          : `${count} tasks running`,
    state.runStartedAt != null && now != null ? `started ${startedAgo(now - state.runStartedAt)}` : "",
  ];
  return parts.filter(Boolean).join(" · ");
}

/**
 * Sticky, on every tab: the project's state in one word, step progress, and
 * one row per concurrently running task with its live reasoning and a Stop
 * button; "Stop all" for the run. Folds to one line once the page scrolls,
 * and opens again on tap.
 */
export function LiveStatusBar({
  project,
  board,
  run: initialRun = null,
  runnable = true,
  ownsNextStep = true,
}: {
  project: ProjectDetail;
  board: ProjectBoardView | null;
  /** The open run's full row, if the page already has it (else streamed). */
  run?: ProjectRun | null;
  /** Readiness gate for "Start next iteration" (the server re-checks). */
  runnable?: boolean;
  /** False where the journey bar owns Continue / Start next iteration. */
  ownsNextStep?: boolean;
}) {
  const slug = project.slug;
  const now = useNow();
  const open = openRunOf(project);
  const [streamedRun, setStreamedRun] = useState<ProjectRun | null>(null);
  const runDetail =
    streamedRun && streamedRun.run_no === open?.run_no ? streamedRun : initialRun;
  useRunLive(slug, open?.run_no ?? 0, open ? open.status : "done", setStreamedRun);
  const inline = useRunActivity(slug, open?.run_no ?? 0, open !== undefined);
  const inlineActive =
    !inline.unavailable && (inline.reasoning !== "" || inline.tools.length > 0);

  const [stop, setStop] = useState<StopRequest | null>(null);
  const [pendingMode, setPendingMode] = useState<StopMode>("now");
  const [dialogOpen, setDialogOpen] = useState(false);
  const stopAll = useProjectAction();
  const [stoppedTasks, setStoppedTasks] = useState<Record<string, LiveTask>>({});

  const effectiveStop: StopRequest | null =
    stopAll.phase === "pending" && open
      ? { runNo: open.run_no, mode: pendingMode, phase: "pending" }
      : stop;
  const state = liveState(project, board, {
    run: runDetail,
    inlineActive,
    stop: effectiveStop,
  });

  const scrolled = useScrolledPast(COLLAPSE_AFTER_PX);
  const [expanded, setExpanded] = useState(false);
  const collapsed = scrolled && !expanded;

  const onStopped = useCallback((task: LiveTask) => {
    setStoppedTasks((prev) => ({ ...prev, [task.id]: task }));
  }, []);

  const confirmStop = (mode: StopMode) => {
    if (!open) return;
    const runNo = open.run_no;
    setPendingMode(mode);
    void stopAll.run(
      `/api/projects/${encodeURIComponent(slug)}/runs/${runNo}/${mode === "now" ? "stop" : "cancel"}`,
      {
        onSuccess: () => {
          setStop({ runNo, mode, phase: "done" });
          setDialogOpen(false);
        },
      },
    );
  };

  const runningIds = new Set(state.running.map((t) => t.id));
  const rows: { task: LiveTask; stopped: boolean }[] = [
    ...state.running.map((task) => ({ task, stopped: task.id in stoppedTasks })),
    ...Object.values(stoppedTasks)
      .filter((t) => !runningIds.has(t.id))
      .map((task) => ({ task, stopped: true })),
  ];
  const stoppedByRun = stop?.phase === "done" && stop.mode === "now";
  const seg = progressSegments(state.done, state.inProgress, state.total);
  const steps =
    state.total > 0 ? (
      <>
        <b>{state.done} of {state.total}</b>{" "}
        {state.countScope === "run" ? "steps" : "cards"} done
      </>
    ) : null;

  return (
    <section
      data-component="LiveStatusBar"
      data-state={state.kind}
      data-collapsed={collapsed ? "true" : undefined}
      aria-label="Live status"
      // With the journey bar above it, the bar owns the sticky slot and the accent.
      className={
        ownsNextStep
          ? "sticky top-0 z-30 rounded-2xl border-2 border-[var(--color-accent)] bg-[var(--color-surface)] px-3 py-2.5 shadow-lg"
          : "rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5"
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={!collapsed}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <StateDot kind={state.kind} />
          <b className={`text-base ${LABEL_COLOUR[state.kind] ?? ""}`}>{state.label}</b>
          <span className={`min-w-0 truncate text-sm text-[var(--color-muted)] ${collapsed ? "hidden sm:inline" : ""}`}>
            {summaryLine(state, project, now)}
          </span>
        </button>
        {steps ? <span className="text-sm">{steps}</span> : null}
        <PrimaryAction
          state={state}
          slug={slug}
          runnable={runnable}
          ownsNextStep={ownsNextStep}
          stopBusy={stopAll.busy}
          onStopAll={() => {
            stopAll.clearError();
            setDialogOpen(true);
          }}
        />
      </div>

      {!collapsed ? (
        <>
          {state.total > 0 ? (
            <div
              data-component="LiveProgress"
              className="mt-2 flex h-2 overflow-hidden rounded-full bg-[var(--color-surface-2)]"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={state.total}
              aria-valuenow={state.done}
            >
              <i className="block h-full bg-emerald-500" style={{ width: `${seg.done}%` }} />
              <i
                className={`block h-full ${state.kind === "stalled" ? "bg-amber-400" : "animate-pulse bg-[var(--color-accent)]/60"}`}
                style={{ width: `${seg.inProgress}%` }}
              />
            </div>
          ) : null}
          {ownsNextStep ? (
            <p className="mt-1.5 text-xs text-[var(--color-muted)]">
              Next for you: <b className="text-[var(--color-fg)]">{state.nextForYou}</b>
            </p>
          ) : null}
          {rows.length > 0 || state.inlineRunning ? (
            <div data-component="LiveTasks" className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
              {state.inlineRunning && state.runNo != null ? (
                <InlineRow
                  slug={slug}
                  runNo={state.runNo}
                  profile={project.host_profile}
                  startedAt={state.runStartedAt}
                  now={now}
                  reasoning={inline.reasoning}
                  tools={inline.tools}
                />
              ) : null}
              {rows.map(({ task, stopped }) => (
                <TaskRow
                  key={task.id}
                  slug={slug}
                  task={task}
                  now={now}
                  stopped={stopped || stoppedByRun}
                  canStop={!project.archived && state.kind !== "stopping"}
                  onStopped={onStopped}
                />
              ))}
            </div>
          ) : null}
        </>
      ) : null}

      {dialogOpen && open ? (
        <StopAllDialog
          runNo={open.run_no}
          runningCount={state.running.length + (state.inlineRunning ? 1 : 0)}
          doneCount={state.done}
          busy={stopAll.busy}
          error={stopAll.error}
          onConfirm={confirmStop}
          onRetry={() => void stopAll.retry()}
          onClose={() => setDialogOpen(false)}
        />
      ) : null}
    </section>
  );
}
