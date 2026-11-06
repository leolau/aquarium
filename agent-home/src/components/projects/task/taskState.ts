import type {
  PlaybookRev,
  ProjectBoardOpenRun,
  ProjectRun,
  ProjectRunCard,
  ProjectDetail,
  ProjectPlaybookDraftState,
  ProjectPlaybookResponse,
} from "@/types";

export type TaskPhase = "planning" | "plan_review" | "ready" | "running" | "waiting" | "failed" | "done";

export const PHASE_LABEL: Record<TaskPhase, string> = {
  planning: "Planning",
  plan_review: "Check the plan",
  ready: "Not started",
  running: "Running",
  waiting: "Needs you",
  failed: "Failed",
  done: "Done",
};

/** The plan a task shows: the active one, else the newest proposed revision. */
export function taskPlan(playbook: ProjectPlaybookResponse | null): PlaybookRev | null {
  if (playbook?.active) return playbook.active;
  const revs = playbook?.revisions ?? [];
  return revs.length > 0 ? [...revs].sort((a, b) => b.rev - a.rev)[0] : null;
}

/** Where a one-off task is, from the same project detail Project mode reads. */
export function taskPhase(
  project: ProjectDetail,
  playbook: ProjectPlaybookResponse | null,
  draft: ProjectPlaybookDraftState | null,
): TaskPhase {
  const latest = project.runs[0];
  if (project.status === "done" || project.status === "archived") return "done";
  if (latest) {
    if (latest.status === "running") return "running";
    if (latest.status === "waiting" || latest.status === "blocked") return "waiting";
    if (latest.status === "failed" || latest.status === "cancelled") return "failed";
    const awaiting = project.output_rollup?.awaiting_acceptance ?? 0;
    return awaiting > 0 || project.status === "needs_completion" ? "done" : "running";
  }
  if (draft?.status === "failed" || draft?.launch?.status === "failed") return "failed";
  if (draft?.status === "running") return "planning";
  if (!playbook?.active && taskPlan(playbook)) return "plan_review";
  // An approved plan with no run: nothing is working until someone starts it.
  if (playbook?.active) return "ready";
  return draft?.status === "idle" ? "failed" : "planning";
}

/** Steps 1..done are ticked; the next one is the current step while running. */
export function stepState(index: number, done: number, phase: TaskPhase): "done" | "current" | "todo" {
  if (phase === "done") return "done";
  if (index < done) return "done";
  if (index === done && (phase === "running" || phase === "waiting")) return "current";
  return "todo";
}

export type StepState = "done" | "current" | "todo";

const SETTLED = new Set(["done", "archived"]);

/**
 * Each plan step's state. With the open run's cards a step is ticked once
 * its card settles and current while its card runs (several may run at
 * once); before any card runs — or without the run's cards — the next
 * unticked step is current, as `stepState` counts it.
 */
export function planStepStates(
  stepKeys: string[],
  phase: TaskPhase,
  done: number,
  cards?: ProjectRunCard[] | null,
): StepState[] {
  if (phase === "done" || !cards || cards.length === 0) {
    return stepKeys.map((_, i) => stepState(i, done, phase));
  }
  const status = new Map(cards.filter((c) => c.step_key).map((c) => [c.step_key as string, c.status]));
  const states: StepState[] = stepKeys.map((key) => {
    const s = status.get(key);
    if (s && SETTLED.has(s)) return "done";
    return s === "running" ? "current" : "todo";
  });
  if (!states.includes("current") && (phase === "running" || phase === "waiting")) {
    const next = states.indexOf("todo");
    if (next >= 0) states[next] = "current";
  }
  return states;
}

/**
 * The cards of a run whose Start already approved them (Task mode). While
 * they sit in triage they are queued for a slot, not waiting on a person,
 * so they stay out of Needs you.
 */
export function queuedCardIds(openRun: ProjectBoardOpenRun | null | undefined): Set<string> {
  return new Set(openRun?.auto_approve ? openRun.card_ids : []);
}

export interface TaskSummary {
  /** Since the task was started; to its finish once done. `null` until the clock is known. */
  totalSeconds: number | null;
  /** The open run's time so far, or `null` with no open run. */
  runSeconds: number | null;
  runNo: number | null;
  runs: number;
  /** Model tokens of every card, `null` when not recorded. */
  tokens: number | null;
  /** The open run's cost from the trace ledger (USD), `null` when not recorded. */
  costUsd: number | null;
}

/**
 * The Task page's time and spend line. `now` is the client clock (epoch
 * seconds) — `null` on the server and while hydrating, when only a finished
 * task's fixed span is shown. `run` is the open run's streamed row.
 */
export function taskSummary(
  project: ProjectDetail,
  run: ProjectRun | null,
  now: number | null,
): TaskSummary {
  const open = project.runs.find((r) => r.status === "running" || r.status === "waiting") ?? null;
  const end = project.completed_at ?? (open ? null : (project.runs[0]?.ended_at ?? null));
  const settled = !open && end != null;
  const totalSeconds = settled
    ? Math.max(0, (end as number) - project.created_at)
    : now != null
      ? Math.max(0, now - project.created_at)
      : null;
  const runSeconds =
    open && now != null && open.started_at != null ? Math.max(0, now - open.started_at) : null;
  const cost = run && open && run.run_no === open.run_no && run.cost_recorded ? (run.cost ?? null) : null;
  return {
    totalSeconds,
    runSeconds,
    runNo: open?.run_no ?? null,
    runs: project.usage?.runs ?? project.runs.length,
    tokens: project.usage?.tokens?.total ?? null,
    costUsd: cost,
  };
}
