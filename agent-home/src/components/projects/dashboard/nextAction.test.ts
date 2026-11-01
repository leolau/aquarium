import { describe, expect, it } from "vitest";

import {
  NOW,
  board,
  card,
  link,
  output,
  playbook,
  project,
  run,
} from "@/components/projects/dashboard/__fixtures__/dashboard";
import { RUN_STALL_SECONDS, agentTriageCards, runStalled } from "@/components/projects/dashboard/derive";
import {
  NEEDS_YOU_ORDER,
  isMutation,
  needsYouItems,
  nextAction,
} from "@/components/projects/dashboard/nextAction";
import type { ReadinessItem } from "@/components/projects/readiness";
import type { ProjectBoardView, ProjectDetail, ProjectPlaybookResponse } from "@/types";

const PB = playbook();

const UNMET = (key: ReadinessItem["key"], extra: Partial<ReadinessItem> = {}): ReadinessItem => ({
  key,
  label: key,
  ok: false,
  hint: `fix ${key}`,
  anchor: `?tab=${key}`,
  ...extra,
});

function hero(
  p: ProjectDetail,
  b: ProjectBoardView | null = board(),
  readiness: ReadinessItem[] = [],
  pb: ProjectPlaybookResponse | null = PB,
) {
  return nextAction(p, b, readiness, pb, NOW);
}

const RUNNING = run({ run_no: 2, status: "running", started_at: NOW - 2 * 3_600, ended_at: null });
const AGENT_TRIAGE = [
  card({ id: "t1", status: "triage", title: "Produce four MOUs", created_by: "default" }),
  card({ id: "t2", status: "triage", title: "Re-verify clauses", created_by: "worker" }),
  card({ id: "t3", status: "triage", title: "Upload v2 set" }),
];

describe("runStalled (mirrors projects_api._run_stalled)", () => {
  it("is false for a run that is not running, or with no cards", () => {
    expect(runStalled(run({ status: "waiting" }), board(card({ status: "blocked" })), NOW)).toBe(false);
    expect(runStalled(RUNNING, board(), NOW)).toBe(false);
    expect(runStalled(RUNNING, null, NOW)).toBe(false);
  });

  it("is false while any card is running or ready", () => {
    expect(runStalled(RUNNING, board(card({ status: "running" }), card({ id: "b", status: "blocked" })), NOW)).toBe(false);
    expect(runStalled(RUNNING, board(card({ status: "ready" })), NOW)).toBe(false);
  });

  it("is true at once when a card is blocked and nothing can move", () => {
    const fresh = { ...RUNNING, started_at: NOW - 5 };
    expect(runStalled(fresh, board(card({ status: "blocked" }), card({ id: "d", status: "done" })), NOW)).toBe(true);
  });

  it("is true only after the stall window when cards are parked elsewhere", () => {
    const b = board(card({ status: "triage" }));
    expect(runStalled({ ...RUNNING, started_at: NOW - RUN_STALL_SECONDS + 10 }, b, NOW)).toBe(false);
    expect(runStalled({ ...RUNNING, started_at: NOW - RUN_STALL_SECONDS - 10 }, b, NOW)).toBe(true);
  });

  it("trusts the server's flag when the payload carries one", () => {
    expect(runStalled({ ...RUNNING, stalled: true }, board(card({ status: "running" })), NOW)).toBe(true);
    expect(runStalled({ ...RUNNING, stalled: false }, board(card({ status: "blocked" })), NOW)).toBe(false);
    expect(runStalled({ ...RUNNING, status: "done", stalled: true }, null, NOW)).toBe(false);
  });
});

describe("agentTriageCards", () => {
  it("keeps the agent's cards, drops ones a person filed and the run's own held cards", () => {
    const p = project();
    const b = board(
      ...AGENT_TRIAGE,
      card({ id: "mine", status: "triage", created_by: "yan" }),
      card({ id: "held", status: "triage", created_by: "projects" }),
      card({ id: "todo", status: "todo", created_by: "default" }),
    );
    expect(agentTriageCards(p, b).map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
  });
});

describe("nextAction priority", () => {
  it("(a) a waiting run comes first, with Continue", () => {
    const p = project({ runs: [run({ run_no: 4, status: "waiting", ended_at: null })] });
    const h = hero(p, board(...AGENT_TRIAGE, card({ id: "b", status: "blocked" })));
    expect(h.state).toBe("waiting");
    expect(h.primary.intent).toEqual({ kind: "continue_run", runNo: 4 });
    expect(h.primary.label).toBe("Continue run 4");
    expect(h.needsPerson).toBe(true);
  });

  it("(a) a stalled run is never reported as fine", () => {
    const p = project({ runs: [RUNNING] });
    const h = hero(p, board(card({ status: "blocked", title: "Waiting on tone" })));
    expect(h.state).toBe("stalled");
    expect(h.tone).toBe("danger");
    expect(h.headline).toBe("Run 2 has stalled");
    expect(h.headline).not.toMatch(/nothing needed/i);
    expect(h.needsPerson).toBe(true);
  });

  it("(a) a stalled run caused by the agent's triage cards leads with approving them", () => {
    const p = project({ runs: [RUNNING] });
    const h = hero(p, board(...AGENT_TRIAGE, card({ id: "d", status: "done" })));
    expect(h.state).toBe("stalled");
    expect(h.tone).toBe("danger");
    expect(h.primary.label).toBe("Approve 3 cards & resume work");
    expect(h.primary.pendingLabel).toBe("Approving…");
    // A run is open, so no new run is started — approving un-sticks it.
    expect(h.primary.intent).toEqual({ kind: "approve_cards", taskIds: ["t1", "t2", "t3"], startRun: false });
    expect(h.why).toMatch(/^Run 2 stalled:/);
  });

  it("(a) the latest run failed and nothing is open: resume it", () => {
    const p = project({ runs: [run({ run_no: 1 }), run({ run_no: 2, status: "failed", outcome: "Drive refused upload" })] });
    const h = hero(p);
    expect(h.state).toBe("failed");
    expect(h.tone).toBe("danger");
    expect(h.why).toBe("Drive refused upload");
    expect(h.primary.intent).toEqual({ kind: "resume_run", runNo: 2 });
  });

  it("(b) agent triage cards with no run open: approve, then start one run", () => {
    const p = project({ runs: [run({ run_no: 2 })] });
    const h = hero(p, board(...AGENT_TRIAGE));
    expect(h.state).toBe("needs_you");
    expect(h.primary.label).toBe("Approve 3 cards & resume work");
    expect(h.primary.intent).toEqual({ kind: "approve_cards", taskIds: ["t1", "t2", "t3"], startRun: true });
    expect(h.primary.effect).toBe("Moves 3 cards to Ready, then starts run 3.");
  });

  it("(b) does not promise to resume work when the project can't run yet", () => {
    const p = project({ runs: [run({ run_no: 2 })] });
    const h = hero(p, board(AGENT_TRIAGE[0]), [UNMET("plan", { tab: "plan" })]);
    expect(h.primary.label).toBe("Approve 1 card");
    expect(h.primary.intent).toMatchObject({ startRun: false });
    const paused = hero(project({ status: "paused", runs: [run()] }), board(AGENT_TRIAGE[0]));
    expect(paused.primary.intent).toMatchObject({ startRun: false });
  });

  it("(b) outranks (c) blocked cards", () => {
    const p = project({ runs: [run()] });
    const h = hero(p, board(card({ id: "b", status: "blocked" }), AGENT_TRIAGE[0]));
    expect(h.key).toBe("triage");
  });

  it("(c) blocked cards: highest priority first; the kind picks the verb", () => {
    const p = project({ runs: [run()] });
    const b = board(
      card({ id: "low", status: "blocked", priority: 1, title: "Low" }),
      card({ id: "high", status: "blocked", priority: 5, title: "High", block_kind: "needs_input" }),
    );
    const h = hero(p, b);
    expect(h.key).toBe("blocked:high");
    expect(h.primary.intent).toEqual({ kind: "open_card", taskId: "high" });
    const items = needsYouItems({ project: p, board: b, readiness: [], playbook: PB, now: NOW });
    const low = items.find((i) => i.key === "blocked:low");
    expect(low?.action.intent).toEqual({ kind: "unblock_card", taskId: "low" });
    expect(low?.action.label).toBe("Retry");
  });

  it("(d) delivered outputs go to the Outputs tab", () => {
    const p = project({ runs: [run()], outputs: [output({ status: "delivered", delivered_at: NOW })] });
    const h = hero(p);
    expect(h.key).toBe("outputs");
    expect(h.primary.intent).toEqual({ kind: "navigate", tab: "outputs" });
    expect(h.headline).toBe("1 delivered output isn't accepted yet");
  });

  it("(d) prefers the server's rollup when present", () => {
    const p = project({
      runs: [run()],
      output_rollup: { total: 3, required: 3, delivered: 2, accepted: 0, awaiting_acceptance: 2 },
    });
    expect(hero(p).headline).toBe("2 delivered outputs aren't accepted yet");
  });

  it("(e) no inputs attached: go to Inputs", () => {
    const p = project({ runs: [run()], links: { url: [link({ kind: "url" })] } });
    const h = hero(p);
    expect(h.key).toBe("inputs");
    expect(h.primary.intent).toEqual({ kind: "navigate", tab: "inputs" });
  });

  it("(e) no inputs on a runnable project still offers starting a run", () => {
    const p = project({ status: "active", runs: [], links: {} });
    const h = hero(p);
    expect(h.key).toBe("inputs");
    expect(h.secondary?.intent).toEqual({ kind: "start_run" });
  });

  it("(e) memory, reference and sample links all count as inputs", () => {
    for (const kind of ["memory", "reference", "sample"] as const) {
      const p = project({ runs: [run()], links: { [kind]: [link({ kind })] } });
      expect(hero(p).key).not.toBe("inputs");
    }
  });

  it("(f) the first unmet readiness item, by its tab", () => {
    const p = project({ runs: [run()] });
    const h = hero(p, board(), [UNMET("profile", { tab: "settings" }), UNMET("plan", { tab: "plan" })]);
    expect(h.key).toBe("readiness:profile");
    expect(h.primary.intent).toEqual({ kind: "navigate", tab: "settings" });
  });

  it("(f) the status item is a one-click Activate", () => {
    const p = project({ status: "planning" });
    const h = hero(p, board(), [UNMET("status")]);
    expect(h.primary.intent).toEqual({ kind: "activate" });
    expect(h.primary.pendingLabel).toBe("Activating…");
  });

  it("(f) a plan revision waiting for approval says so", () => {
    const h = hero(project(), board(), [UNMET("plan", { tab: "plan", hint: "Rev 4 is waiting for your approval." })]);
    expect(h.headline).toBe("A plan revision is waiting for you");
    expect(h.primary.label).toBe("Review the plan");
  });

  it("(g) a healthy working run: nothing needed, plus the next checkpoint", () => {
    const p = project({ runs: [RUNNING] });
    const b = board(card({ id: "r", status: "running" }), card({ id: "d", status: "done" }));
    const pb = playbook([
      { key: "a", title: "Draft" },
      { key: "b", title: "Review drafts", checkpoint: true },
    ]);
    const h = hero(p, b, [], pb);
    expect(h.state).toBe("working");
    expect(h.needsPerson).toBe(false);
    expect(h.headline).toBe("Nothing needed from you right now");
    expect(h.why).toContain("1 task running");
    expect(h.why).toContain("1 of 2 cards done");
    expect(h.why).toContain("review at “Review drafts” (step 2 of 2)");
    expect(h.primary.intent).toEqual({ kind: "open_run", runNo: 2 });
  });

  it("(h) idle after work: start the next iteration, or say what to change", () => {
    const p = project({ runs: [run({ run_no: 2 })] });
    const h = hero(p);
    expect(h.state).toBe("idle");
    expect(h.headline).toBe("Start the next iteration");
    expect(h.primary.label).toBe("Start iteration 3");
    expect(h.primary.intent).toEqual({ kind: "start_run" });
    expect(h.primary.effect).toBe("Starts run 3 with plan rev 3.");
    expect(h.secondary?.intent).toEqual({ kind: "change_request" });
  });

  it("(h) every output accepted on a one-off: offer Mark done", () => {
    const p = project({ runs: [run({ run_no: 2 })], outputs: [output({ status: "accepted" })] });
    const h = hero(p);
    expect(h.primary.intent).toEqual({ kind: "mark_done" });
    expect(h.secondary?.intent).toEqual({ kind: "start_run" });
  });

  it("(h) a repeatable project never offers Mark done", () => {
    const p = project({ cadence: "repeatable", runs: [run()], outputs: [output({ status: "accepted" })] });
    expect(hero(p).primary.intent).toEqual({ kind: "start_run" });
  });

  it("brand-new and ready: start iteration 1", () => {
    const h = hero(project());
    expect(h.state).toBe("ready");
    expect(h.primary.label).toBe("Start iteration 1");
  });

  it("archived and done projects ask nothing", () => {
    expect(hero(project({ archived: true, runs: [run({ status: "waiting" })] })).state).toBe("archived");
    expect(hero(project({ status: "done", runs: [run()] })).state).toBe("done");
  });
});

describe("needsYouItems", () => {
  const p = project({
    runs: [run({ run_no: 3, status: "waiting", ended_at: null })],
    outputs: [output({ status: "delivered" })],
    links: {},
  });
  const b = board(AGENT_TRIAGE[0], card({ id: "b", status: "blocked" }));
  const items = needsYouItems({
    project: p,
    board: b,
    readiness: [UNMET("schedule", { tab: "settings" })],
    playbook: PB,
    now: NOW,
  });

  it("lists every category (a)–(f), ranked", () => {
    expect(items.map((i) => i.group)).toEqual(["run", "triage", "blocked", "outputs", "inputs", "readiness"]);
    const ranks = items.map((i) => NEEDS_YOU_ORDER.indexOf(i.group));
    expect([...ranks].sort((x, y) => x - y)).toEqual(ranks);
  });

  it("gives every item a one-tap action", () => {
    for (const item of items) {
      expect(item.action.label.length).toBeGreaterThan(0);
      expect(item.action.effect.length).toBeGreaterThan(0);
      if (isMutation(item.action.intent)) expect(item.action.pendingLabel).toBeTruthy();
    }
  });
});

describe("nextAction invariants", () => {
  const scenarios: [string, ProjectDetail, ProjectBoardView | null, ReadinessItem[]][] = [
    ["waiting", project({ runs: [run({ status: "waiting" })] }), board(), []],
    ["stalled-blocked", project({ runs: [RUNNING] }), board(card({ status: "blocked" })), []],
    ["stalled-old", project({ runs: [RUNNING] }), board(card({ status: "todo" })), []],
    ["stalled-triage", project({ runs: [RUNNING] }), board(...AGENT_TRIAGE), []],
    ["failed", project({ runs: [run({ status: "failed" })] }), board(), []],
    ["blocked-run", project({ runs: [run({ status: "blocked" })] }), board(), []],
    ["triage", project({ runs: [run()] }), board(...AGENT_TRIAGE), []],
    ["blocked", project({ runs: [run()] }), board(card({ status: "blocked" })), []],
    ["outputs", project({ outputs: [output({ status: "delivered" })] }), board(), []],
    ["inputs", project({ links: {} }), null, []],
    ["readiness", project(), board(), [UNMET("outputs", { tab: "outputs" })]],
    ["working", project({ runs: [RUNNING] }), board(card({ status: "running" })), []],
    ["idle", project({ runs: [run()] }), board(), []],
    ["new", project(), board(), []],
  ];

  it.each(scenarios)("%s: never 'nothing needed' while someone is needed", (_name, p, b, r) => {
    const items = needsYouItems({ project: p, board: b, readiness: r, playbook: PB, now: NOW });
    const h = nextAction(p, b, r, PB, NOW);
    expect(h).not.toBeNull();
    expect(h.headline.length).toBeGreaterThan(0);
    if (items.length > 0) {
      expect(h.needsPerson).toBe(true);
      expect(h.state).not.toBe("working");
      expect(items.some((i) => i.key === h.key)).toBe(true);
    }
  });

  it.each(scenarios.filter(([name]) => name.startsWith("stalled") || name === "failed" || name === "blocked-run"))(
    "%s: a stalled or failed run is never calm",
    (_name, p, b, r) => {
      const h = nextAction(p, b, r, PB, NOW);
      expect(h.tone).toBe("danger");
      expect(["stalled", "failed"]).toContain(h.state);
    },
  );
});
