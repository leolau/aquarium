/**
 * Server markup of the live bar in its three resting shapes: working with
 * two concurrent tasks, stalled, and idle — the bar is never absent and
 * never a blank box.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/mou/cards/t1",
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

import type {
  ProjectBoardTask,
  ProjectBoardView,
  ProjectDetail,
  ProjectRun,
  ProjectRunBrief,
} from "@/types";

import { LiveStatusBar, NO_REASONING, fallbackNote, lastHeardAt } from "./LiveStatusBar";

const NOW = Math.floor(Date.now() / 1000);

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

const PROJECT = (over: Partial<ProjectDetail> = {}): ProjectDetail =>
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
  title: "Draft MOU · ConnectAR ↔ Dr Wong",
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
    ],
    stalled: false,
    ...over,
  }) as ProjectRun;

describe("LiveStatusBar (SSR)", () => {
  it("working with two concurrent tasks: two rows, steps, Stop on each, Stop all", () => {
    const html = renderToStaticMarkup(
      <LiveStatusBar
        project={PROJECT()}
        board={BOARD(CARD({ id: "t1" }), CARD({ id: "t2", title: "Draft MOU · Mr Chan" }))}
        run={RUN()}
      />,
    );
    expect(html).toContain('data-component="LiveStatusBar"');
    expect(html).toContain('data-state="working"');
    expect(html).toContain("sticky top-0 z-30");
    expect(html).toContain('data-dot="pulse"');
    expect(html).toContain("Working");
    // Clock-dependent text waits for hydration (React #418).
    expect(html).toContain("Run 3 · 2 tasks running</span>");
    expect(html).not.toContain("min ago");
    expect(html).toContain("<b>1 of 3</b> steps done");
    expect(html.match(/data-component="LiveTaskRow"/g)).toHaveLength(2);
    expect(html).toContain("Draft MOU · Mr Chan");
    expect(html).toContain("step 2 of 3 · worker on default</div>");
    expect(html).toContain('href="/projects/mou/cards/t1"');
    expect(html.match(/■ Stop</g)).toHaveLength(2);
    expect(html).toContain("■ Stop all");
    expect(html).toContain("md:grid-cols-2");
    expect(html).toContain("Next for you:");
    // No reasoning yet: the row says so instead of an empty box.
    expect(html).toContain(NO_REASONING);
  });

  it("stalled: red word, Close run, and what to unstick", () => {
    const html = renderToStaticMarkup(
      <LiveStatusBar
        project={PROJECT()}
        board={BOARD(CARD({ id: "x", status: "triage" }))}
        run={RUN({ stalled: true, cards: [{ task_id: "a", step_key: "a", status: "done", title: "A" }, { task_id: "x", step_key: "b", status: "triage", title: "B" }] })}
      />,
    );
    expect(html).toContain('data-state="stalled"');
    expect(html).toContain("Stalled");
    expect(html).toContain("Run 3 · nothing is running");
    expect(html).toContain("■ Close run 3");
    expect(html).not.toContain("■ Stop all");
    expect(html).toContain("approve 1 card waiting in Triage");
    expect(html).not.toContain('data-component="LiveTaskRow"');
  });

  it("idle: still shown, with Start next iteration", () => {
    const html = renderToStaticMarkup(
      <LiveStatusBar
        project={PROJECT({ runs: [BRIEF({ status: "done", ended_at: NOW - 60 })] })}
        board={BOARD()}
      />,
    );
    expect(html).toContain('data-state="idle"');
    expect(html).toContain("Idle");
    expect(html).toContain("Run 3 finished · nothing running");
    expect(html).toContain("▶ Start next iteration");
    expect(html).not.toContain("■ Stop");
  });

  it("idle but not ready: the start button is disabled", () => {
    const html = renderToStaticMarkup(
      <LiveStatusBar project={PROJECT({ runs: [] })} board={null} runnable={false} />,
    );
    expect(html).toContain("No runs yet");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>▶ Start next iteration/);
  });

  it("needs you: Continue run N", () => {
    const html = renderToStaticMarkup(
      <LiveStatusBar project={PROJECT({ runs: [BRIEF({ status: "waiting" })] })} board={BOARD()} />,
    );
    expect(html).toContain('data-state="needs_you"');
    expect(html).toContain("Continue run 3");
  });
});

describe("fallbackNote / lastHeardAt", () => {
  const card = {
    ...CARD({}),
    latest_heartbeat: { note: "93/131 done", created_at: 50 },
    comments: [{ author: "w", body: "Halfway", created_at: 70 }],
  };
  it("prefers the heartbeat note, then the last comment", () => {
    expect(fallbackNote(card)).toBe("93/131 done");
    expect(fallbackNote({ ...card, latest_heartbeat: null })).toBe("Halfway");
    expect(fallbackNote(null)).toBeNull();
  });
  it("takes the newest of activity, heartbeat, comment and start", () => {
    expect(lastHeardAt(60, card, 10)).toBe(70);
    expect(lastHeardAt(90, card, 10)).toBe(90);
    expect(lastHeardAt(null, null, 10)).toBe(10);
    expect(lastHeardAt(null, null, null)).toBeNull();
  });
});
