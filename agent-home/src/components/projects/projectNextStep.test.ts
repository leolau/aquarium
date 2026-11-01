import { describe, expect, it } from "vitest";

import { project as detail } from "@/components/projects/dashboard/__fixtures__/dashboard";
import { projectNextStep } from "@/components/projects/projectNextStep";
import type { ProjectListItem } from "@/types";

function item(over: Partial<ProjectListItem> = {}, cards: Partial<ProjectListItem["progress"]["cards"]> = {}): ProjectListItem {
  const base = detail();
  return {
    ...base,
    progress: {
      rung: "cards",
      label: "cards",
      headline: "1 of 2 cards done",
      cards: { total: 2, done: 1, running: 0, blocked: 0, ...cards },
    },
    output_rollup: { total: 1, required: 1, delivered: 0, accepted: 0, awaiting_acceptance: 0 },
    member_count: 1,
    health: "ok",
    ...over,
  } as ProjectListItem;
}

describe("projectNextStep (list chip, from row data only)", () => {
  it("says nothing for finished or archived projects", () => {
    expect(projectNextStep(item({ status: "done" }))).toBeNull();
    expect(projectNextStep(item({ archived: true }))).toBeNull();
  });

  it("asks the person first for what only they can do", () => {
    expect(projectNextStep(item({ status: "needs_completion" }))?.text).toBe("Needs you · finish setting it up");
    expect(
      projectNextStep(item({ output_rollup: { total: 3, required: 3, delivered: 3, accepted: 0, awaiting_acceptance: 3 } }))?.text,
    ).toBe("Needs you · accept 3 outputs");
    expect(projectNextStep(item({}, { blocked: 1 }))?.text).toBe("Needs you · 1 blocked card");
    expect(projectNextStep(item({ health: "stalled" }))).toEqual({ tone: "danger", text: "Stalled · see why" });
  });

  it("walks set-up, activation, running and mark-done", () => {
    expect(
      projectNextStep(item({ output_rollup: { total: 0, required: 0, delivered: 0, accepted: 0, awaiting_acceptance: 0 } }))?.text,
    ).toBe("Set up · declare an output");
    expect(projectNextStep(item({ status: "planning" }))?.text).toBe("Next · activate");
    expect(projectNextStep(item({ status: "paused" }))?.text).toBe("Next · activate");
    expect(projectNextStep(item({}, { running: 2 }))?.text).toBe("Running · the agent has it");
    expect(
      projectNextStep(item({ output_rollup: { total: 1, required: 1, delivered: 1, accepted: 1, awaiting_acceptance: 0 } }))?.text,
    ).toBe("Next · mark it done");
  });

  it("stays quiet for a healthy active project with nothing to do", () => {
    expect(projectNextStep(item())).toBeNull();
    expect(projectNextStep(item({ output_rollup: undefined }))).toBeNull();
  });
});
