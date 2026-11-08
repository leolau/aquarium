import { describe, expect, it } from "vitest";

import {
  NOW,
  board,
  card,
  directive,
  output,
  playbook,
  project,
  run,
} from "@/components/projects/dashboard/__fixtures__/dashboard";
import { activityEntries } from "@/components/projects/dashboard/activity";
import { plural, quoteTitles, spanLabel } from "@/components/projects/dashboard/derive";
import { initial, personLabel, requirementsSummary } from "@/components/projects/dashboard/requirements";
import { confirmedText, mutationSteps } from "@/components/projects/dashboard/steps";
import { cardsBar, outputsBar, standSteps } from "@/components/projects/dashboard/standProgress";

const RUNNING = run({ run_no: 2, status: "running", started_at: NOW - 7_200, ended_at: null });

function states(...args: Parameters<typeof standSteps>) {
  return Object.fromEntries(standSteps(...args).map((s) => [s.key, [s.state, s.sub]]));
}

describe("standSteps", () => {
  it("brand-new and set up: Iteration 1 is next", () => {
    const s = states(project(), board(), playbook([{ key: "a", title: "A" }], 1), NOW);
    expect(s.brief).toEqual(["done", null]);
    expect(s.inputs).toEqual(["done", null]);
    expect(s.plan).toEqual(["done", "rev 1"]);
    expect(s.iteration).toEqual(["current", "not started"]);
    expect(s.review).toEqual(["todo", null]);
    expect(s.done).toEqual(["todo", null]);
  });

  it("flags a missing brief, inputs and plan", () => {
    const s = states(project({ goal: "", outputs: [], links: {} }), null, null, NOW);
    expect(s.brief[0]).toBe("attention");
    expect(s.inputs[0]).toBe("attention");
    expect(s.plan).toEqual(["attention", null]);
    expect(s.iteration).toEqual(["todo", "not started"]);
  });

  it("a working run is current; a stalled one is attention", () => {
    const p = project({ runs: [RUNNING] });
    expect(states(p, board(card({ status: "running" })), playbook(), NOW).iteration).toEqual(["current", "working"]);
    expect(states(p, board(card({ status: "blocked" })), playbook(), NOW).iteration).toEqual(["attention", "stalled"]);
    const label = standSteps(p, board(), playbook(), NOW).find((s) => s.key === "iteration")?.label;
    expect(label).toBe("Iteration 2");
  });

  it("a waiting run needs you", () => {
    const p = project({ runs: [run({ status: "waiting" })] });
    expect(states(p, board(), playbook(), NOW).iteration).toEqual(["attention", "waiting for you"]);
  });

  it("a failed last run is attention, never done", () => {
    const p = project({ runs: [run({ status: "failed" })] });
    expect(states(p, board(), playbook(), NOW).iteration).toEqual(["attention", "failed"]);
  });

  it("delivered outputs put Review & accept current", () => {
    const p = project({ runs: [run()], outputs: [output({ status: "delivered" })] });
    const s = states(p, board(), playbook(), NOW);
    expect(s.iteration).toEqual(["done", "idle"]);
    expect(s.review[0]).toBe("current");
  });

  it("all accepted: Done is next; a done project is all ticks", () => {
    const accepted = project({ runs: [run()], outputs: [output({ status: "accepted" })] });
    expect(states(accepted, board(), playbook(), NOW).done[0]).toBe("current");
    const done = states(project({ status: "done", runs: [run()], outputs: [output({ status: "accepted" })] }), board(), playbook(), NOW);
    expect(Object.values(done).every(([state]) => state === "done")).toBe(true);
  });
});

describe("progress bars", () => {
  it("outputsBar counts accepted / delivered / in progress of required", () => {
    const p = project({
      outputs: [
        output({ id: "a", status: "accepted" }),
        output({ id: "b", status: "delivered" }),
        output({ id: "c", status: "in_progress" }),
        output({ id: "d", status: "pending", required: 0 }),
        output({ id: "e", status: "dropped" }),
      ],
    });
    const bar = outputsBar(p);
    expect(bar.summary).toBe("1 of 3 accepted · 1 delivered · 1 in progress");
    expect(bar.total).toBe(4);
    expect(bar.segments.map((s) => [s.key, s.count, s.percent])).toEqual([
      ["accepted", 1, 25],
      ["delivered", 1, 25],
      ["in_progress", 1, 25],
    ]);
  });

  it("outputsBar says when nothing is declared", () => {
    expect(outputsBar(project({ outputs: [] })).summary).toBe("No outputs declared yet");
  });

  it("cardsBar splits done / ready-or-working / needs you, ignoring archived", () => {
    const bar = cardsBar(
      board(
        card({ id: "1", status: "done" }),
        card({ id: "2", status: "running" }),
        card({ id: "3", status: "ready" }),
        card({ id: "4", status: "triage" }),
        card({ id: "5", status: "blocked" }),
        card({ id: "6", status: "archived" }),
      ),
    );
    expect(bar?.summary).toBe("1 of 5 cards done");
    expect(bar?.segments.map((s) => [s.key, s.count])).toEqual([
      ["done", 1],
      ["working", 2],
      ["needs", 2],
    ]);
    expect(cardsBar(null)).toBeNull();
  });
});

describe("requirementsSummary", () => {
  it("brief points, then active project directives with the newest flagged", () => {
    const summary = requirementsSummary(project(), {
      applies_from: "next_run",
      directives: [
        directive({ id: "old", body: "Use 2.5% split", created_at: NOW - 3 * 86_400 }),
        directive({ id: "new", body: "3-year term", created_at: NOW - 3_600, author_user_id: "leo" }),
        directive({ id: "gone", body: "Retired", active: 0, retired_at: NOW - 10 }),
        directive({ id: "card", body: "Card-only", scope: "card" }),
        directive({ id: "fb", kind: "feedback", body: "Nice" }),
      ],
    });
    expect(summary.lines.map((l) => l.key)).toEqual([
      "goal",
      "outputs",
      "dod",
      "directive:old",
      "directive:new",
    ]);
    expect(summary.lines[1].text).toBe("Deliver: 4 MOUs in docx");
    expect(summary.lines.filter((l) => l.isNew).map((l) => l.key)).toEqual(["directive:new"]);
    expect(summary.lines[4]).toMatchObject({ author: "leo", at: NOW - 3_600 });
    // v1 = the brief; every requirement change (incl. retired) bumps it.
    expect(summary.version).toBe(5);
  });

  it("is v1 with no directives, and clips long text", () => {
    const summary = requirementsSummary(project({ goal: "x".repeat(300) }), null);
    expect(summary.version).toBe(1);
    expect(summary.lines[0].text.length).toBe(140);
    expect(summary.lines[0].text.endsWith("…")).toBe(true);
    expect(summary.lines.some((l) => l.isNew)).toBe(false);
  });

  it("names people", () => {
    expect(personLabel("yan", "yan")).toBe("You");
    expect(personLabel("leo", "yan")).toBe("leo");
    expect(personLabel(null, "yan")).toBe("Someone");
    expect(initial("leo")).toBe("L");
    expect(initial(" ")).toBe("?");
  });
});

describe("activityEntries", () => {
  const b = board(card({ id: "t1", title: "Draft MOU" }));

  it("writes card events and run starts/ends as sentences, newest first", () => {
    const p = project({
      runs: [run({ run_no: 1, status: "failed", started_at: NOW - 500, ended_at: NOW - 100 })],
      recent_events: [
        { id: 1, task_id: "t1", kind: "created", payload: { by: "default" }, created_at: NOW - 400 },
        { id: 2, task_id: "t1", kind: "heartbeat", payload: null, created_at: NOW - 300 },
        { id: 5, task_id: "t1", kind: "assignment", payload: { fit: "strong" }, created_at: NOW - 250 },
        { id: 3, task_id: "t1", kind: "commented", payload: { author: "yan" }, created_at: NOW - 200 },
        { id: 4, task_id: "zz", kind: "some_new_kind", payload: null, created_at: NOW - 50 },
      ],
    });
    const entries = activityEntries(p, b);
    expect(entries.map((e) => e.text)).toEqual([
      "A card: some new kind",
      "Run 1 failed",
      "New comment on “Draft MOU”",
      "Card “Draft MOU” was created",
      "Run 1 started",
    ]);
    expect(entries.map((e) => e.tone)).toEqual(["muted", "bad", "change", "change", "now"]);
    expect(entries[2].actor).toBe("yan");
    expect(entries[3].actor).toBe("default");
  });

  it("collapses repeats and honours the limit", () => {
    const events = Array.from({ length: 5 }, (_, i) => ({
      id: i,
      task_id: "t1",
      kind: "edited",
      payload: null,
      created_at: NOW - i,
    }));
    expect(activityEntries(project({ recent_events: events }), b)).toHaveLength(1);
    const many = Array.from({ length: 20 }, (_, i) => run({ run_no: i + 1, started_at: NOW - i * 100, ended_at: null }));
    expect(activityEntries(project({ runs: many }), b, 4)).toHaveLength(4);
  });
});

describe("mutationSteps", () => {
  it("approve N cards PATCHes each to ready, then POSTs one run only if asked", () => {
    const steps = mutationSteps("my proj", { kind: "approve_cards", taskIds: ["a", "b/c"], startRun: true });
    expect(steps).toEqual([
      { path: "/api/projects/my%20proj/cards/a", method: "PATCH", body: { status: "ready" } },
      { path: "/api/projects/my%20proj/cards/b%2Fc", method: "PATCH", body: { status: "ready" } },
      { path: "/api/projects/my%20proj/runs", method: "POST" },
    ]);
    expect(mutationSteps("p", { kind: "approve_cards", taskIds: ["a"], startRun: false })).toHaveLength(1);
  });

  it("maps every mutation to its route; navigation sends nothing", () => {
    expect(mutationSteps("p", { kind: "continue_run", runNo: 3 })).toEqual([{ path: "/api/projects/p/runs/3/continue", method: "POST" }]);
    expect(mutationSteps("p", { kind: "resume_run", runNo: 3 })).toEqual([{ path: "/api/projects/p/runs/3/resume", method: "POST" }]);
    expect(mutationSteps("p", { kind: "start_run" })).toEqual([{ path: "/api/projects/p/runs", method: "POST" }]);
    expect(mutationSteps("p", { kind: "unblock_card", taskId: "t" })).toEqual([
      { path: "/api/projects/p/cards/t", method: "PATCH", body: { status: "ready" } },
    ]);
    expect(mutationSteps("p", { kind: "activate" })).toEqual([{ path: "/api/projects/p", method: "PATCH", body: { status: "active" } }]);
    expect(mutationSteps("p", { kind: "mark_done" })).toEqual([{ path: "/api/projects/p", method: "PATCH", body: { status: "done" } }]);
    expect(mutationSteps("p", { kind: "navigate", tab: "board" })).toEqual([]);
    expect(mutationSteps("p", { kind: "change_request" })).toEqual([]);
  });

  it("confirmedText reads the started run from the server's answer", () => {
    expect(confirmedText({ kind: "approve_cards", taskIds: ["a", "b"], startRun: true }, { run: { run_no: 7 } })).toBe(
      "Approved 2 cards. Run 7 started.",
    );
    expect(confirmedText({ kind: "approve_cards", taskIds: ["a"], startRun: false }, {})).toBe("Approved 1 card.");
    expect(confirmedText({ kind: "start_run" }, { run_no: 4 })).toBe("Run 4 started.");
    expect(confirmedText({ kind: "start_run" }, null)).toBe("Run started.");
  });
});

describe("copy helpers", () => {
  it("quoteTitles / plural / spanLabel", () => {
    expect(quoteTitles(["A"])).toBe("“A”");
    expect(quoteTitles(["A", "B"])).toBe("“A” and “B”");
    expect(quoteTitles(["A", "B", "C", "D"])).toBe("“A”, “B”, “C” and 1 more");
    expect(plural(1, "card")).toBe("1 card");
    expect(plural(2, "card")).toBe("2 cards");
    expect(spanLabel(30)).toBe("1 min");
    expect(spanLabel(7_200)).toBe("2 h");
    expect(spanLabel(3 * 86_400)).toBe("3 d");
  });
});
