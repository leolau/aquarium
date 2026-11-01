import type { Tone } from "@/components/ui/Pill";
import type { ProjectListItem } from "@/types";

export interface NextStepChip {
  tone: Tone;
  text: string;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The list row's "next step" chip, read only from what the list row already
 * carries (status, health, output rollup, card rollup) — never a per-row
 * fetch. Coarser than the project page's journey bar on purpose: the row
 * cannot see runs or triage cards, so it never claims to.
 */
export function projectNextStep(project: ProjectListItem): NextStepChip | null {
  if (project.archived || project.status === "done") return null;
  if (project.status === "needs_completion") {
    return { tone: "warning", text: "Needs you · finish setting it up" };
  }
  const rollup = project.output_rollup;
  const cards = project.progress.cards;
  if (project.health === "stalled") return { tone: "danger", text: "Stalled · see why" };
  if ((rollup?.awaiting_acceptance ?? 0) > 0) {
    return { tone: "warning", text: `Needs you · accept ${plural(rollup!.awaiting_acceptance, "output")}` };
  }
  if (cards.blocked > 0) {
    return { tone: "danger", text: `Needs you · ${plural(cards.blocked, "blocked card")}` };
  }
  if (rollup && rollup.total === 0) return { tone: "accent", text: "Set up · declare an output" };
  if (project.status === "planning" || project.status === "paused") {
    return { tone: "accent", text: "Next · activate" };
  }
  if (cards.running > 0) return { tone: "muted", text: "Running · the agent has it" };
  if (
    project.cadence === "one_off" &&
    rollup &&
    rollup.required > 0 &&
    rollup.accepted >= rollup.required
  ) {
    return { tone: "accent", text: "Next · mark it done" };
  }
  if (project.health === "attention") return { tone: "warning", text: "Needs you · open it" };
  return null;
}
