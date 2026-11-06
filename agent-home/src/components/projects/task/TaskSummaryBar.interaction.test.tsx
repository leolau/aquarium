// @vitest-environment jsdom
/**
 * Task mode's time and spend line: total and current-run time tick on the
 * client clock, tokens come from the project's usage read and cost from the
 * open run's streamed row; it says "not recorded" rather than inventing 0.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectDetail, ProjectRun, ProjectRunBrief } from "@/types";

import { taskSummary } from "./taskState";
import { TaskSummaryBar } from "./TaskSummaryBar";

const NOW = 1_800_000_000;

const BRIEF = (over: Partial<ProjectRunBrief> = {}): ProjectRunBrief => ({
  run_no: 1,
  status: "running",
  trigger: "manual",
  started_at: NOW - 125,
  ended_at: null,
  duration_seconds: null,
  outcome: null,
  score_user: null,
  ...over,
});

const PROJECT = (over: Partial<ProjectDetail> = {}): ProjectDetail =>
  ({
    id: "prj_1",
    slug: "crm",
    created_at: NOW - 600,
    completed_at: null,
    runs: [BRIEF()],
    usage: { runs: 1, run_seconds: 120, tokens: { total: 48_210 } },
    ...over,
  }) as unknown as ProjectDetail;

const RUN = (over: Partial<ProjectRun> = {}): ProjectRun =>
  ({ run_no: 1, status: "running", cost: 0.4321, cost_recorded: true, ...over }) as ProjectRun;

describe("taskSummary", () => {
  it("counts the task and the open run up to now, with tokens and the run's cost", () => {
    expect(taskSummary(PROJECT(), RUN(), NOW)).toEqual({
      totalSeconds: 600,
      runSeconds: 125,
      runNo: 1,
      runs: 1,
      tokens: 48_210,
      costUsd: 0.4321,
    });
  });

  it("knows no clock before hydration and no cost the ledger didn't record", () => {
    const s = taskSummary(PROJECT({ usage: { runs: 1, run_seconds: 0, tokens: null } }), RUN({ cost: null, cost_recorded: false }), null);
    expect(s.totalSeconds).toBeNull();
    expect(s.runSeconds).toBeNull();
    expect(s.tokens).toBeNull();
    expect(s.costUsd).toBeNull();
  });

  it("stops the clock at a finished task's end, with no run time", () => {
    const done = PROJECT({ runs: [BRIEF({ status: "done", ended_at: NOW - 60 })] });
    expect(taskSummary(done, null, NOW)).toMatchObject({ totalSeconds: 540, runSeconds: null, runNo: null });
    expect(taskSummary(done, null, null).totalSeconds).toBe(540);
  });

  it("ignores a streamed row of another run", () => {
    expect(taskSummary(PROJECT(), RUN({ run_no: 2 }), NOW).costUsd).toBeNull();
  });
});

describe("TaskSummaryBar", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const value = (key: string) => document.querySelector(`[data-summary="${key}"] dd`)?.textContent;

  it("shows time, tokens and cost, and keeps ticking by itself", async () => {
    render(<TaskSummaryBar project={PROJECT()} run={RUN()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("Total time")).toBeTruthy();
    expect(value("total")).toBe("10m 0s");
    expect(value("run")).toBe("2m 5s");
    expect(value("tokens")).toBe("48,210");
    expect(value("cost")).toBe("$0.43");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(value("total")).toBe("10m 3s");
    expect(value("run")).toBe("2m 8s");
  });

  it("picks up new token totals from the page's refresh", () => {
    const { rerender } = render(<TaskSummaryBar project={PROJECT()} run={null} />);
    rerender(<TaskSummaryBar project={PROJECT({ usage: { runs: 1, run_seconds: 130, tokens: { total: 50_000 } } as ProjectDetail["usage"] })} run={null} />);
    expect(value("tokens")).toBe("50,000");
    expect(document.querySelector('[data-summary="cost"]')).toBeNull();
  });

  it("says tokens were not recorded rather than zero", () => {
    render(<TaskSummaryBar project={PROJECT({ usage: { runs: 1, run_seconds: 0, tokens: null } })} run={null} />);
    expect(value("tokens")).toBe("not recorded");
  });
});
