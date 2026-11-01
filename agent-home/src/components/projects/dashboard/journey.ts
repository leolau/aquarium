import type { DashIntent, NextAction } from "@/components/projects/dashboard/nextAction";
import { latestRun } from "@/components/projects/dashboard/derive";
import type { ReadinessItem } from "@/components/projects/readiness";
import type { ProjectDetail } from "@/types";

/** The five stops every project passes through, in order. */
export type JourneyPhase = "setup" | "ready" | "running" | "review" | "done";

export const JOURNEY_STEPS: { phase: JourneyPhase; label: string }[] = [
  { phase: "setup", label: "Set up" },
  { phase: "ready", label: "Ready" },
  { phase: "running", label: "Running" },
  { phase: "review", label: "Review" },
  { phase: "done", label: "Done" },
];

/**
 * Where the project stands on Set up → Ready → Running → Review → Done,
 * read off the same `nextAction()` the bar's button comes from, so the
 * highlighted step and the button can never disagree.
 */
export function journeyPhase(
  project: ProjectDetail,
  readiness: ReadinessItem[],
  action: NextAction,
): JourneyPhase {
  if (action.state === "archived" || action.state === "done") return "done";
  if (project.status === "done") return "done";
  if (action.state === "ready") return "ready";
  if (
    action.state === "waiting" ||
    action.state === "stalled" ||
    action.state === "failed" ||
    action.state === "working"
  ) {
    return "running";
  }
  const everRan = latestRun(project) !== null || project.card_rollup.done > 0;
  if (action.state === "idle") {
    if (action.key === "mark_done") return "review";
    return project.outputs.some((o) => o.status === "delivered" || o.status === "accepted")
      ? "review"
      : "running";
  }
  // needs_you: which kind of help is asked for decides the stop.
  if (action.key === "outputs") return "review";
  if (action.key === "triage" || action.key.startsWith("blocked:")) return "running";
  if (project.status === "needs_completion") return "setup";
  const runnable = readiness.every((item) => item.ok);
  if (action.key.startsWith("readiness:") || action.key.startsWith("scope:")) {
    if (!everRan) return "setup";
    // A paused project that already ran is one click from going again.
    return action.key === "readiness:status" ? "ready" : "running";
  }
  if (!everRan) return runnable ? "ready" : "setup";
  return "running";
}

/** The short "next:" phrase per readiness check. */
export const READINESS_NEXT: Record<ReadinessItem["key"], string> = {
  outputs: "declare an output",
  profile: "pick a profile to run on",
  plan: "write the plan",
  status: "activate the project",
  schedule: "set a schedule",
};

export interface ReadinessProgress {
  ok: number;
  total: number;
  next: ReadinessItem | null;
}

export function readinessProgress(readiness: ReadinessItem[]): ReadinessProgress {
  return {
    ok: readiness.filter((item) => item.ok).length,
    total: readiness.length,
    next: readiness.find((item) => !item.ok) ?? null,
  };
}

/** "2 of 4 ready — next: declare an output", or null once all are ready. */
export function readinessLine(readiness: ReadinessItem[]): string | null {
  const { ok, total, next } = readinessProgress(readiness);
  if (!next) return null;
  return `${ok} of ${total} ready — next: ${READINESS_NEXT[next.key]}`;
}

/** Mirrors the API gates (`_require_write`, `judgement=True` for member acts). */
const LEAD_ONLY = new Set<DashIntent["kind"]>(["activate", "mark_done"]);
const MEMBER_ACTS = new Set<DashIntent["kind"]>([
  "start_run",
  "continue_run",
  "resume_run",
  "approve_cards",
  "unblock_card",
]);

/**
 * Why the person in front of the page cannot press the primary button, said
 * before the click instead of as a 403 after it. Null when they can.
 */
export function primaryBlockedReason(
  intent: DashIntent,
  { canLead, canAct }: { canLead: boolean; canAct: boolean },
): string | null {
  if (LEAD_ONLY.has(intent.kind) && !canLead) {
    return "Only the project owner or a lead can do this step.";
  }
  if (MEMBER_ACTS.has(intent.kind) && !canAct) {
    return "Viewers can't do this step — ask a member or the owner.";
  }
  return null;
}
