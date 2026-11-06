/**
 * The live status bar's derivations, kept pure so every state is testable
 * without a DOM: which one word the project is in, what is running, how far
 * the run has got, and what the person should do next.
 */
import type {
  ProjectBoardTask,
  ProjectBoardView,
  ProjectDetail,
  ProjectRun,
  ProjectRunBrief,
} from "@/types";

export type LiveStateKind =
  | "working"
  | "needs_you"
  | "stalled"
  | "idle"
  | "stopping"
  | "stopped";

export const LIVE_STATE_LABEL: Record<LiveStateKind, string> = {
  working: "Working",
  needs_you: "Needs you",
  stalled: "Stalled",
  idle: "Idle",
  stopping: "Stopping…",
  stopped: "Stopped",
};

export type StopMode = "now" | "finish";

/** A Stop all the person asked for, as the bar remembers it. */
export interface StopRequest {
  runNo: number;
  mode: StopMode;
  /** `pending` until the server confirms; then `done`. */
  phase: "pending" | "done";
}

export interface LiveTask {
  id: string;
  title: string;
  /** The worker profile on it (the card's assignee). */
  profile: string | null;
  startedAt: number | null;
  /** 1-based position among the run's steps, when the run lists it. */
  stepIndex: number | null;
  stepTotal: number | null;
}

export type LivePrimary =
  | { kind: "stop_all"; runNo: number }
  | { kind: "continue"; runNo: number }
  | { kind: "close"; runNo: number }
  | { kind: "start" };

export interface LiveState {
  kind: LiveStateKind;
  label: string;
  /** The open run (or the last one, when idle). */
  runNo: number | null;
  runStartedAt: number | null;
  /** Board cards a worker is on right now. */
  running: LiveTask[];
  /** The run's inline steps are streaming in the web server's process. */
  inlineRunning: boolean;
  done: number;
  inProgress: number;
  total: number;
  /** Whether done/total count the open run's steps or the whole board. */
  countScope: "run" | "board";
  triage: number;
  blocked: number;
  /** "Next for you: …" — never empty. */
  nextForYou: string;
  primary: LivePrimary | null;
  /** Stop all is offered (an open run that is not already stopping). */
  canStopAll: boolean;
}

export interface LiveInputs {
  /** The open run's full row (cards, `stalled`, checkpoint), when loaded. */
  run?: ProjectRun | null;
  /** Inline steps are currently streaming (from `useRunActivity`). */
  inlineActive?: boolean;
  stop?: StopRequest | null;
}

const OPEN = new Set(["running", "waiting", "blocked"]);

export function openRunOf(project: ProjectDetail): ProjectRunBrief | undefined {
  return project.runs.find((run) => OPEN.has(run.status));
}

function boardTasks(board: ProjectBoardView | null): ProjectBoardTask[] {
  const seen = new Set<string>();
  const out: ProjectBoardTask[] = [];
  for (const column of board?.columns ?? []) {
    for (const task of column.tasks) {
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      out.push(task);
    }
  }
  return out;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function liveState(
  project: ProjectDetail,
  board: ProjectBoardView | null,
  inputs: LiveInputs = {},
): LiveState {
  const tasks = boardTasks(board).filter(
    (t) => t.project_id == null || t.project_id === project.id,
  );
  const open = openRunOf(project);
  const detail =
    open && inputs.run && inputs.run.run_no === open.run_no ? inputs.run : null;
  const runCards = detail?.cards ?? [];
  const stepOf = new Map(runCards.map((c, i) => [c.task_id, i + 1]));

  const running: LiveTask[] = tasks
    .filter((t) => t.status === "running")
    .map((t) => ({
      id: t.id,
      title: t.title,
      profile: t.assignee,
      startedAt: t.started_at,
      stepIndex: stepOf.get(t.id) ?? null,
      stepTotal: stepOf.has(t.id) ? runCards.length : null,
    }));
  const triage = tasks.filter((t) => t.status === "triage").length;
  // Start already approved this run's cards (Task mode): triage is a queue.
  const approved = open?.auto_approve === true;
  const blocked = tasks.filter((t) => t.status === "blocked").length;
  const inlineRunning =
    !!open && open.status === "running" && inputs.inlineActive === true;

  let total: number;
  let done: number;
  let inProgress: number;
  let countScope: "run" | "board";
  if (detail && runCards.length > 0) {
    total = runCards.length;
    done = runCards.filter((c) => c.status === "done").length;
    inProgress = runCards.filter((c) => c.status === "running").length;
    countScope = "run";
  } else {
    total = project.card_rollup.total;
    done = project.card_rollup.done;
    inProgress = running.length;
    countScope = "board";
  }

  const base = {
    runNo: open?.run_no ?? project.runs[0]?.run_no ?? null,
    runStartedAt: open?.started_at ?? null,
    running,
    inlineRunning,
    done,
    inProgress,
    total,
    countScope,
    triage,
    blocked,
  };
  const make = (
    kind: LiveStateKind,
    nextForYou: string,
    primary: LivePrimary | null,
    canStopAll: boolean,
  ): LiveState => ({
    ...base,
    kind,
    label: LIVE_STATE_LABEL[kind],
    nextForYou,
    primary: project.archived ? null : primary,
    canStopAll: !project.archived && canStopAll,
  });

  const stop = inputs.stop;
  if (stop && (!open || open.run_no === stop.runNo)) {
    if (stop.phase === "pending") {
      return make("stopping", "nothing — the run is stopping. Work already done is kept.", null, false);
    }
    if (stop.mode === "finish" && running.length > 0) {
      return make(
        "stopping",
        `nothing — ${plural(running.length, "running step")} will finish, then run ${stop.runNo} stops.`,
        null,
        false,
      );
    }
    return make(
      "stopped",
      "start the next iteration when you're ready. Work already done is kept.",
      project.status === "active" ? { kind: "start" } : null,
      false,
    );
  }

  if (!open) {
    const last = project.runs[0];
    // Cards waiting in Triage are the actionable thing — mention them
    // before the last run's fate so "failed" doesn't bury the real ask.
    const next =
      project.status !== "active"
        ? "activate the project to start running it."
        : triage > 0
          ? `approve ${plural(triage, "card")} waiting in Triage, then start the next iteration.`
          : last?.status === "failed"
            ? `run ${last.run_no} failed — open it to see why, or start the next iteration.`
            : "start the next iteration when you're ready, or tell the agent what to change below.";
    return make(
      "idle",
      next,
      project.status === "active" ? { kind: "start" } : null,
      false,
    );
  }

  const busy = running.length > 0 || inlineRunning;
  const checkpoint = detail?.checkpoint_wait?.checkpoint_title ?? null;
  const held =
    open.status === "waiting" ||
    open.status === "blocked" ||
    (detail?.awaiting_continue === true && !busy);
  if (held) {
    return make(
      "needs_you",
      checkpoint
        ? `review “${checkpoint}”, then continue run ${open.run_no}.`
        : `run ${open.run_no} is waiting on you — check it, then continue.`,
      { kind: "continue", runNo: open.run_no },
      true,
    );
  }

  const humanWait = detail?.waiting_on_you?.[0];
  if (humanWait && !busy) {
    return make(
      "needs_you",
      `answer “${humanWait.title ?? humanWait.task_id}” so run ${open.run_no} can continue.`,
      { kind: "stop_all", runNo: open.run_no },
      true,
    );
  }

  if (busy) {
    const next = detail?.awaiting_continue
      ? `review the checkpoint${checkpoint ? ` “${checkpoint}”` : ""}, then continue run ${open.run_no}.`
      : triage > 0 && approved
        ? `nothing right now. ${plural(triage, "step")} queued; ${triage === 1 ? "it starts" : "they start"} on ${triage === 1 ? "its" : "their"} own as work frees up.`
        : triage > 0
          ? `${plural(triage, "card")} wait${triage === 1 ? "s" : ""} in Triage for your approval.`
          : "nothing right now. You'll be told when the agent needs you.";
    return make("working", next, { kind: "stop_all", runNo: open.run_no }, true);
  }

  if (detail?.stalled === true) {
    const next =
      triage > 0 && !approved
        ? `approve ${plural(triage, "card")} waiting in Triage so work can continue.`
        : blocked > 0
          ? `unblock ${plural(blocked, "card")} so work can continue.`
          : `close run ${open.run_no}, or start it again.`;
    return make("stalled", next, { kind: "close", runNo: open.run_no }, true);
  }

  // Open, nothing running, and the server does not call it stalled: the
  // next step is queued for a worker to pick up.
  return make(
    "working",
    "nothing right now — the next step is waiting for a worker.",
    { kind: "stop_all", runNo: open.run_no },
    true,
  );
}

// ── Time ──────────────────────────────────────────────────────────────────

/** Silence over this many seconds turns the row amber. */
export const QUIET_AFTER_S = 60;
/** …and over this many, red. */
export const SILENT_AFTER_S = 300;

export type SilenceLevel = "ok" | "quiet" | "silent";

export function silenceLevel(seconds: number | null): SilenceLevel {
  if (seconds == null) return "ok";
  if (seconds > SILENT_AFTER_S) return "silent";
  if (seconds > QUIET_AFTER_S) return "quiet";
  return "ok";
}

/** "45s" · "6m 12s" · "1h 4m" — a running task's elapsed time. */
export function elapsedLabel(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** "12 min ago" · "just now" — when the run started. */
export function startedAgo(seconds: number | null): string {
  if (seconds == null) return "";
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** The newest `n` non-empty lines, oldest first (newest at the bottom). */
export function lastLines(text: string, n = 4): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-n);
}

/** Done and in-progress widths for the progress bar, in percent. */
export function progressSegments(done: number, inProgress: number, total: number) {
  if (total <= 0) return { done: 0, inProgress: 0 };
  const d = Math.min(100, Math.round((done / total) * 100));
  const p = Math.min(100 - d, Math.round((inProgress / total) * 100));
  return { done: d, inProgress: p };
}
