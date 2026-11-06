import { describe, expect, it } from "vitest";

import type { ProjectDetail, ProjectPlaybookResponse } from "@/types";

import { planStepStates, queuedCardIds, taskPhase } from "./taskState";

const project = (over: Partial<ProjectDetail> = {}) =>
  ({ status: "active", runs: [], output_rollup: null, ...over }) as unknown as ProjectDetail;
const withActive = { active: { rev: 2, steps: [] }, revisions: [] } as unknown as ProjectPlaybookResponse;

describe("taskPhase", () => {
  it("an approved plan with no run is ready to start, not running", () => {
    expect(taskPhase(project(), withActive, null)).toBe("ready");
  });

  it("a run in progress is running", () => {
    const p = project({ runs: [{ run_no: 1, status: "running" }] as unknown as ProjectDetail["runs"] });
    expect(taskPhase(p, withActive, null)).toBe("running");
  });

  it("while the agent drafts the plan it is planning", () => {
    expect(
      taskPhase(project({ status: "planning" }), null, { status: "running" } as never),
    ).toBe("planning");
  });
});

describe("planStepStates", () => {
  const KEYS = ["find", "price", "report"];
  const card = (step_key: string, status: string) => ({ task_id: `t_${step_key}`, step_key, status, title: step_key });

  it("highlights the step whose card is running, not the next by count", () => {
    const cards = [card("find", "triage"), card("price", "running"), card("report", "triage")];
    expect(planStepStates(KEYS, "running", 0, cards)).toEqual(["todo", "current", "todo"]);
  });

  it("ticks settled cards and marks every running one current", () => {
    const cards = [card("find", "done"), card("price", "running"), card("report", "running")];
    expect(planStepStates(KEYS, "running", 1, cards)).toEqual(["done", "current", "current"]);
  });

  it("falls back to the next unticked step when nothing runs, or without the run's cards", () => {
    const cards = [card("find", "archived"), card("price", "triage"), card("report", "triage")];
    expect(planStepStates(KEYS, "waiting", 1, cards)).toEqual(["done", "current", "todo"]);
    expect(planStepStates(KEYS, "running", 1, null)).toEqual(["done", "current", "todo"]);
    expect(planStepStates(KEYS, "done", 0, cards)).toEqual(["done", "done", "done"]);
  });
});

describe("queuedCardIds", () => {
  const RUN = { run_no: 1, status: "running", started_at: 1, card_ids: ["a", "b"], blocked_tree_count: 0, stalled: false };

  it("treats an auto-approved run's cards as queued", () => {
    expect([...queuedCardIds({ ...RUN, auto_approve: true })]).toEqual(["a", "b"]);
  });

  it("queues nothing for a run that still asks", () => {
    expect(queuedCardIds({ ...RUN, auto_approve: false }).size).toBe(0);
    expect(queuedCardIds(null).size).toBe(0);
  });
});
