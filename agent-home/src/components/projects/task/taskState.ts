import type {
  PlaybookRev,
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
