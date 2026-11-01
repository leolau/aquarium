import { describe, expect, it } from "vitest";

import {
  NOW,
  board,
  card,
  output,
  playbook,
  project,
  run,
} from "@/components/projects/dashboard/__fixtures__/dashboard";
import {
  JOURNEY_STEPS,
  journeyPhase,
  primaryBlockedReason,
  readinessLine,
  type JourneyPhase,
} from "@/components/projects/dashboard/journey";
import { nextAction, type NextActionState } from "@/components/projects/dashboard/nextAction";
import type { ReadinessItem } from "@/components/projects/readiness";
import type { ProjectBoardView, ProjectDetail } from "@/types";

const UNMET = (key: ReadinessItem["key"]): ReadinessItem => ({
  key,
  label: key,
  ok: false,
  hint: `fix ${key}`,
  anchor: `?tab=${key}`,
});
const MET = (key: ReadinessItem["key"]): ReadinessItem => ({ ...UNMET(key), ok: true });

function phaseOf(
  p: ProjectDetail,
  b: ProjectBoardView | null = board(),
  readiness: ReadinessItem[] = [],
): { phase: JourneyPhase; state: NextActionState; key: string } {
  const action = nextAction(p, b, readiness, playbook(), NOW);
  return { phase: journeyPhase(p, readiness, action), state: action.state, key: action.key };
}

const CASES: { name: string; state: NextActionState; phase: JourneyPhase; run: () => ReturnType<typeof phaseOf> }[] = [
  { name: "archived", state: "archived", phase: "done", run: () => phaseOf(project({ archived: true })) },
  { name: "done", state: "done", phase: "done", run: () => phaseOf(project({ status: "done", runs: [run()] })) },
  {
    name: "waiting run",
    state: "waiting",
    phase: "running",
    run: () => phaseOf(project({ runs: [run({ status: "waiting", ended_at: null })] })),
  },
  {
    name: "stalled run",
    state: "stalled",
    phase: "running",
    run: () =>
      phaseOf(
        project({ runs: [run({ status: "running", started_at: NOW - 36_000, ended_at: null })] }),
        board(card({ status: "blocked" })),
      ),
  },
  { name: "failed run", state: "failed", phase: "running", run: () => phaseOf(project({ runs: [run({ status: "failed" })] })) },
  {
    name: "working run",
    state: "working",
    phase: "running",
    run: () =>
      phaseOf(
        project({ runs: [run({ status: "running", started_at: NOW - 60, ended_at: null })] }),
        board(card({ status: "running" })),
      ),
  },
  { name: "brand-new, everything in place", state: "ready", phase: "ready", run: () => phaseOf(project()) },
  {
    name: "a run finished, nothing delivered yet",
    state: "idle",
    phase: "running",
    run: () => phaseOf(project({ runs: [run()] })),
  },
  {
    name: "everything accepted (Mark done)",
    state: "idle",
    phase: "review",
    run: () => phaseOf(project({ runs: [run()], outputs: [output({ status: "accepted" })] })),
  },
  {
    name: "needs you: declare an output before any run",
    state: "needs_you",
    phase: "setup",
    run: () => phaseOf(project({ outputs: [], status: "planning" }), board(), [UNMET("outputs"), UNMET("status")]),
  },
  {
    name: "needs you: activate, never ran",
    state: "needs_you",
    phase: "setup",
    run: () => phaseOf(project({ status: "planning" }), board(), [MET("outputs"), UNMET("status")]),
  },
  {
    name: "needs you: re-activate a paused project that ran",
    state: "needs_you",
    phase: "ready",
    run: () => phaseOf(project({ status: "paused", runs: [run()] }), board(), [MET("outputs"), UNMET("status")]),
  },
  {
    name: "needs you: approve the agent's triage cards",
    state: "needs_you",
    phase: "running",
    run: () =>
      phaseOf(project({ runs: [run()] }), board(card({ id: "t1", status: "triage", created_by: "default" }))),
  },
  {
    name: "needs you: a blocked card",
    state: "needs_you",
    phase: "running",
    run: () => phaseOf(project({ runs: [run()] }), board(card({ status: "blocked" }))),
  },
  {
    name: "needs you: accept a delivered output",
    state: "needs_you",
    phase: "review",
    run: () => phaseOf(project({ runs: [run()], outputs: [output({ status: "delivered" })] })),
  },
  {
    name: "needs you: no inputs yet, otherwise ready",
    state: "needs_you",
    phase: "ready",
    run: () => phaseOf(project({ links: {} })),
  },
  {
    name: "needs completion (legacy import)",
    state: "needs_you",
    phase: "setup",
    run: () => phaseOf(project({ status: "needs_completion", outputs: [] }), board(), [UNMET("outputs"), UNMET("status")]),
  },
];

describe("journeyPhase", () => {
  it.each(CASES)("$name → $phase", ({ run: go, state, phase }) => {
    const got = go();
    expect(got.state).toBe(state);
    expect(got.phase).toBe(phase);
  });

  it("covers every nextAction state", () => {
    const all: NextActionState[] = ["waiting", "stalled", "failed", "needs_you", "working", "idle", "ready", "done", "archived"];
    expect(new Set(CASES.map((c) => c.state))).toEqual(new Set(all));
  });

  it("always names one of the five steps", () => {
    const phases = JOURNEY_STEPS.map((s) => s.phase);
    for (const c of CASES) expect(phases).toContain(c.run().phase);
  });
});

describe("readinessLine", () => {
  it("counts what is ready and names the first gap", () => {
    expect(readinessLine([MET("outputs"), MET("profile"), UNMET("plan"), UNMET("status")])).toBe(
      "2 of 4 ready — next: write the plan",
    );
    expect(readinessLine([UNMET("outputs"), MET("profile")])).toBe("1 of 2 ready — next: declare an output");
  });

  it("is null once everything is ready", () => {
    expect(readinessLine([MET("outputs"), MET("status")])).toBeNull();
    expect(readinessLine([])).toBeNull();
  });
});

describe("primaryBlockedReason", () => {
  it("mirrors the API gates: lifecycle is lead-only, run acts are member acts", () => {
    const lead = { canLead: true, canAct: true };
    const member = { canLead: false, canAct: true };
    const viewer = { canLead: false, canAct: false };
    expect(primaryBlockedReason({ kind: "activate" }, lead)).toBeNull();
    expect(primaryBlockedReason({ kind: "mark_done" }, member)).toMatch(/owner or a lead/);
    expect(primaryBlockedReason({ kind: "start_run" }, member)).toBeNull();
    expect(primaryBlockedReason({ kind: "continue_run", runNo: 2 }, viewer)).toMatch(/Viewers/);
    expect(primaryBlockedReason({ kind: "navigate", tab: "outputs" }, viewer)).toBeNull();
  });
});
