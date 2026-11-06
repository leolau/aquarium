import { describe, expect, it } from "vitest";

import type { ProjectDetail, ProjectPlaybookResponse } from "@/types";

import { taskPhase } from "./taskState";

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
