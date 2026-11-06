/**
 * The live bar's one word, its counts and its "Next for you" line, derived
 * from the same data the page already has — every state, plus the time
 * thresholds that turn a quiet task amber and then red.
 */
import { describe, expect, it } from "vitest";

import type {
  ProjectBoardTask,
  ProjectBoardView,
  ProjectDetail,
  ProjectRun,
  ProjectRunBrief,
} from "@/types";

import {
  elapsedLabel,
  lastLines,
  liveState,
  parkedText,
  progressSegments,
  silenceLevel,
  startedAgo,
} from "./liveState";

const NOW = 1_800_000_000;

const BRIEF = (over: Partial<ProjectRunBrief> = {}): ProjectRunBrief => ({
  run_no: 3,
  status: "running",
  trigger: "manual",
  started_at: NOW - 720,
  ended_at: null,
  duration_seconds: null,
  outcome: null,
  score_user: null,
  ...over,
});

export const PROJECT = (over: Partial<ProjectDetail> = {}): ProjectDetail =>
  ({
    id: "prj_1",
    slug: "mou",
    name: "Prepare the MOUs",
    status: "active",
    archived: false,
    host_profile: "default",
    runs: [BRIEF()],
    card_rollup: { total: 7, done: 3, running: 2, blocked: 0 },
    ...over,
  }) as ProjectDetail;

const CARD = (over: Partial<ProjectBoardTask>): ProjectBoardTask => ({
  id: "t1",
  title: "Draft MOU",
  body: null,
  status: "running",
  assignee: "default",
  priority: 0,
  created_at: NOW - 3_600,
  started_at: NOW - 372,
  completed_at: null,
  tenant: null,
  project_id: "prj_1",
  result: null,
  current_step_key: null,
  ...over,
});

const BOARD = (...tasks: ProjectBoardTask[]): ProjectBoardView => ({
  columns: [{ name: "all", tasks }],
});

const RUN = (over: Partial<ProjectRun> = {}): ProjectRun =>
  ({
    id: "run_3",
    project_id: "prj_1",
    run_no: 3,
    status: "running",
    started_at: NOW - 720,
    ended_at: null,
    cards: [
      { task_id: "a", step_key: "a", status: "done", title: "A" },
      { task_id: "t1", step_key: "b", status: "running", title: "B" },
      { task_id: "t2", step_key: "c", status: "running", title: "C" },
      { task_id: "d", step_key: "d", status: "triage", title: "D" },
    ],
    stalled: false,
    ...over,
  }) as ProjectRun;

describe("liveState", () => {
  it("is Working with one row per running card, steps from the run", () => {
    const s = liveState(
      PROJECT(),
      BOARD(CARD({ id: "t1" }), CARD({ id: "t2", title: "Second" }), CARD({ id: "x", status: "done" })),
      { run: RUN() },
    );
    expect(s.kind).toBe("working");
    expect(s.label).toBe("Working");
    expect(s.running.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(s.running[0]).toMatchObject({ stepIndex: 2, stepTotal: 4, profile: "default" });
    expect([s.done, s.inProgress, s.total]).toEqual([1, 2, 4]);
    expect(s.primary).toEqual({ kind: "stop_all", runNo: 3 });
    expect(s.canStopAll).toBe(true);
    expect(s.nextForYou).toMatch(/nothing right now/i);
  });

  it("falls back to the project's card rollup before the run row loads", () => {
    const s = liveState(PROJECT(), BOARD(CARD({ id: "t1" })));
    expect([s.done, s.total]).toEqual([3, 7]);
    expect(s.running[0].stepIndex).toBeNull();
  });

  it("ignores another project's cards and a card listed twice", () => {
    const c = CARD({ id: "t1" });
    const s = liveState(
      PROJECT(),
      { columns: [{ name: "a", tasks: [c] }, { name: "b", tasks: [c, CARD({ id: "z", project_id: "other" })] }] },
    );
    expect(s.running.map((t) => t.id)).toEqual(["t1"]);
  });

  it("counts inline steps as work", () => {
    const s = liveState(PROJECT(), BOARD(), { inlineActive: true, run: RUN({ cards: [] }) });
    expect(s.kind).toBe("working");
    expect(s.inlineRunning).toBe(true);
  });

  it("is Needs you for a waiting run, naming the checkpoint", () => {
    const s = liveState(PROJECT({ runs: [BRIEF({ status: "waiting" })] }), BOARD(), {
      run: RUN({
        status: "waiting",
        checkpoint_wait: { checkpoint_task_id: "c", checkpoint_title: "Review the drafts", comment: null, held_task_ids: [] },
      }),
    });
    expect(s.kind).toBe("needs_you");
    expect(s.primary).toEqual({ kind: "continue", runNo: 3 });
    expect(s.nextForYou).toContain("Review the drafts");
  });

  it("is Needs you when a checkpoint holds a running row with nothing running", () => {
    const s = liveState(PROJECT(), BOARD(), { run: RUN({ awaiting_continue: true }) });
    expect(s.kind).toBe("needs_you");
  });

  it("is Needs you when a card only a person can clear holds the run", () => {
    const s = liveState(PROJECT(), BOARD(CARD({ status: "blocked" })), {
      run: RUN({
        waiting_on_you: [
          { task_id: "g", title: "Connect Folder Bridge", block_kind: "needs_input", reason: null },
        ],
      }),
    });
    expect(s.kind).toBe("needs_you");
    expect(s.nextForYou).toContain("Connect Folder Bridge");
  });

  it("says a block-loop-parked card is re-planning and needs you, not running", () => {
    const s = liveState(PROJECT(), BOARD(CARD({ status: "triage" })), {
      run: RUN({
        waiting_on_you: [
          {
            task_id: "g",
            title: "Get the supplier price",
            block_kind: "needs_input",
            reason: null,
            parked: true,
            block_recurrences: 2,
            replan: { status: "drafting" },
          },
        ],
      }),
    });
    expect(s.kind).toBe("needs_you");
    expect(s.nextForYou).toContain("parked after 2 blocks — re-planning");
    expect(
      parkedText({ block_recurrences: 2, replan: { status: "proposed", rev: 4 } }),
    ).toContain("revision 4");
  });

  it("is Stalled on the server's stall signal, and says what to unstick", () => {
    const s = liveState(
      PROJECT(),
      BOARD(CARD({ id: "a", status: "triage" }), CARD({ id: "b", status: "triage" })),
      { run: RUN({ stalled: true }) },
    );
    expect(s.kind).toBe("stalled");
    expect(s.primary).toEqual({ kind: "close", runNo: 3 });
    expect(s.nextForYou).toMatch(/approve 2 cards/);
    const blocked = liveState(PROJECT(), BOARD(CARD({ status: "blocked" })), { run: RUN({ stalled: true }) });
    expect(blocked.nextForYou).toMatch(/unblock 1 card/);
  });

  it("does not call an open run stalled unless the server does", () => {
    const s = liveState(PROJECT(), BOARD(), { run: RUN({ stalled: false }) });
    expect(s.kind).toBe("working");
    expect(s.nextForYou).toMatch(/waiting for a worker/);
  });

  it("is Idle with no open run, offering the next iteration", () => {
    const s = liveState(PROJECT({ runs: [BRIEF({ status: "done", ended_at: NOW })] }), BOARD());
    expect(s.kind).toBe("idle");
    expect(s.primary).toEqual({ kind: "start" });
    expect(s.canStopAll).toBe(false);
  });

  it("Idle after a failure says so; an inactive project offers no start", () => {
    expect(
      liveState(PROJECT({ runs: [BRIEF({ status: "failed" })] }), null).nextForYou,
    ).toMatch(/run 3 failed/);
    const draft = liveState(PROJECT({ status: "draft" as ProjectDetail["status"], runs: [] }), null);
    expect(draft.primary).toBeNull();
    expect(draft.nextForYou).toMatch(/activate/);
  });

  it("an archived project shows its state but offers no buttons", () => {
    const s = liveState(PROJECT({ archived: true }), BOARD(CARD({})));
    expect(s.kind).toBe("working");
    expect(s.primary).toBeNull();
    expect(s.canStopAll).toBe(false);
  });

  it("is Stopping… while a stop is in flight, then Stopped", () => {
    const board = BOARD(CARD({}));
    const pending = liveState(PROJECT(), board, { stop: { runNo: 3, mode: "now", phase: "pending" } });
    expect(pending.kind).toBe("stopping");
    expect(pending.label).toBe("Stopping…");
    expect(pending.primary).toBeNull();
    const done = liveState(PROJECT({ runs: [BRIEF({ status: "cancelled" })] }), BOARD(), {
      stop: { runNo: 3, mode: "now", phase: "done" },
    });
    expect(done.kind).toBe("stopped");
    expect(done.primary).toEqual({ kind: "start" });
  });

  it("finish-then-stop stays Stopping… while its running steps finish", () => {
    const s = liveState(PROJECT({ runs: [BRIEF({ status: "cancelled" })] }), BOARD(CARD({})), {
      stop: { runNo: 3, mode: "finish", phase: "done" },
    });
    expect(s.kind).toBe("stopping");
    expect(s.nextForYou).toMatch(/1 running step will finish/);
  });

  it("a remembered stop does not leak onto the next run", () => {
    const s = liveState(PROJECT({ runs: [BRIEF({ run_no: 4 })] }), BOARD(CARD({})), {
      stop: { runNo: 3, mode: "now", phase: "done" },
    });
    expect(s.kind).toBe("working");
  });
});

describe("time thresholds", () => {
  it("turns amber after a minute of silence and red after five", () => {
    expect(silenceLevel(null)).toBe("ok");
    expect(silenceLevel(0)).toBe("ok");
    expect(silenceLevel(60)).toBe("ok");
    expect(silenceLevel(61)).toBe("quiet");
    expect(silenceLevel(300)).toBe("quiet");
    expect(silenceLevel(301)).toBe("silent");
  });

  it("labels elapsed time at the grain a person reads", () => {
    expect(elapsedLabel(null)).toBe("—");
    expect(elapsedLabel(-3)).toBe("0s");
    expect(elapsedLabel(45.9)).toBe("45s");
    expect(elapsedLabel(372)).toBe("6m 12s");
    expect(elapsedLabel(3_840)).toBe("1h 4m");
  });

  it("says how long ago the run started", () => {
    expect(startedAgo(null)).toBe("");
    expect(startedAgo(20)).toBe("just now");
    expect(startedAgo(720)).toBe("12 min ago");
    expect(startedAgo(7_300)).toBe("2h ago");
    expect(startedAgo(200_000)).toBe("2d ago");
  });
});

describe("lastLines / progressSegments", () => {
  it("keeps the newest lines, newest at the bottom", () => {
    expect(lastLines("a\n\n b \nc\nd\ne", 4)).toEqual(["b", "c", "d", "e"]);
    expect(lastLines("", 4)).toEqual([]);
  });

  it("splits the bar into done and in-progress, never over 100%", () => {
    expect(progressSegments(3, 2, 7)).toEqual({ done: 43, inProgress: 29 });
    expect(progressSegments(0, 0, 0)).toEqual({ done: 0, inProgress: 0 });
    expect(progressSegments(5, 5, 5)).toEqual({ done: 100, inProgress: 0 });
  });

  it("calls triage cards of a run Start approved a queue, not a wait for approval", () => {
    const board = BOARD(CARD({ id: "t1" }), CARD({ id: "d", status: "triage" }));
    const asks = liveState(PROJECT(), board, { run: RUN() });
    expect(asks.nextForYou).toMatch(/wait.* in Triage for your approval/);
    const approved = liveState(PROJECT({ runs: [BRIEF({ auto_approve: true })] }), board, { run: RUN() });
    expect(approved.kind).toBe("working");
    expect(approved.nextForYou).toMatch(/nothing right now\. 1 step queued/);
    expect(approved.nextForYou).not.toMatch(/approval/);
  });

  it("never asks to approve the queue of a stalled auto-approved run", () => {
    const board = BOARD(CARD({ id: "d", status: "triage" }));
    const run = RUN({ stalled: true, cards: [{ task_id: "d", step_key: "d", status: "triage", title: "D" }] });
    const s = liveState(PROJECT({ runs: [BRIEF({ auto_approve: true })] }), board, { run });
    expect(s.kind).toBe("stalled");
    expect(s.nextForYou).not.toMatch(/approve/);
  });
});
