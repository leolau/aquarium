// @vitest-environment jsdom
/**
 * Archived gating on the run page (U7 UI): a shelved project's run keeps
 * its record visible but hides every growing write — Continue, Repeat
 * this run, Save retro, the score control — while Cancel (a reducing act)
 * stays, matching what the router refuses and permits.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/monday-digest/cards/t_pricing",
  useRouter: () => router,
}));

import { RunView } from "@/components/projects/RunView";
import type { ProjectRun } from "@/types";

const NOW = Math.floor(Date.now() / 1000);

const RUN = (over: Partial<ProjectRun>): ProjectRun => ({
  id: "run_1",
  project_id: "prj_1",
  run_no: 1,
  trigger: "manual",
  triggered_by: "leo",
  profile: "default",
  playbook_rev: 1,
  status: "waiting",
  started_at: NOW - 3600,
  ended_at: null,
  session_id: null,
  trace_id: null,
  outcome: null,
  summary: null,
  retro: null,
  retro_at: null,
  score_self: null,
  score_user: null,
  score_note: null,
  scored_by: null,
  scored_at: null,
  error: null,
  cards: [],
  deliveries: [],
  ...over,
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("RunView on an archived project", () => {
  it("hides the growing writes, keeps Cancel, shows the hint", () => {
    const { queryByRole, queryByLabelText, getByText } = render(
      <RunView slug="monday-digest" run={RUN({})} archived />,
    );
    expect(queryByRole("button", { name: "Continue" })).toBeNull();
    expect(queryByRole("button", { name: "Save retro" })).toBeNull();
    expect(queryByLabelText("Score this run from 1 to 5")).toBeNull();
    expect(queryByRole("button", { name: "Repeat this run" })).toBeNull();
    // Cancel is the sanctioned way out — it stays.
    expect(queryByRole("button", { name: "Cancel" })).not.toBeNull();
    expect(getByText(/This project is archived/)).toBeTruthy();
  });

  it("still offers every write on a live project", () => {
    const { getByRole, getByLabelText, queryByText } = render(
      <RunView slug="monday-digest" run={RUN({})} />,
    );
    expect(getByRole("button", { name: "Continue" })).toBeTruthy();
    expect(getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(getByRole("button", { name: "Save retro" })).toBeTruthy();
    expect(getByLabelText("Score this run from 1 to 5")).toBeTruthy();
    expect(queryByText(/This project is archived/)).toBeNull();
  });

  it("hides Repeat this run on a finished archived run", () => {
    const finished = RUN({ status: "done", ended_at: NOW });
    const archivedView = render(
      <RunView slug="monday-digest" run={finished} archived />,
    );
    expect(
      archivedView.queryByRole("button", { name: "Repeat this run" }),
    ).toBeNull();
    archivedView.unmount();

    const liveView = render(<RunView slug="monday-digest" run={finished} />);
    expect(
      liveView.getByRole("button", { name: "Repeat this run" }),
    ).toBeTruthy();
  });
});

describe("RunView stall truth", () => {
  it("flags a stalled running run and offers stop + restart + retry", () => {
    const stalledRun = RUN({
      status: "running",
      stalled: true,
      cards: [
        { task_id: "t_1", step_key: "draft", status: "todo", title: "Draft" },
      ],
      blocked_tasks: [
        {
          task_id: "t_9",
          title: "Extract objectives",
          status: "blocked",
          error: "worker exited cleanly (rc=0) — protocol violation",
        },
      ],
    });
    const { getByText, getByRole } = render(
      <RunView slug="monday-digest" run={stalledRun} />,
    );
    expect(getByText(/^stalled$/i)).toBeTruthy();
    expect(getByText(/no worker is active/)).toBeTruthy();
    // Stop and restart offered together on a stalled run.
    expect(getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(getByRole("button", { name: "Repeat this run" })).toBeTruthy();
    // The blocked work is listed with why it stopped.
    expect(getByText("Extract objectives")).toBeTruthy();
    expect(getByText(/protocol violation/)).toBeTruthy();
  });

  it("shows no stall UI on a healthy running run", () => {
    const healthy = RUN({
      status: "running",
      stalled: false,
      cards: [
        {
          task_id: "t_1",
          step_key: "draft",
          status: "running",
          title: "Draft",
        },
      ],
    });
    const { queryByText, queryByRole } = render(
      <RunView slug="monday-digest" run={healthy} />,
    );
    expect(queryByText("stalled")).toBeNull();
    expect(queryByText(/no worker is active/)).toBeNull();
    expect(queryByRole("button", { name: "Repeat this run" })).toBeNull();
  });
});

describe("RunView Stop now", () => {
  it("asks first, then posts to the stop verb — not cancel", async () => {
    const fetchMock = vi.fn(
      async (url: string) =>
        ({
          ok: true,
          json: async () => ({ status: "cancelled", outcome: "stopped" }),
          url,
        }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);
    const { getByRole } = render(
      <RunView slug="monday-digest" run={RUN({ status: "running" })} />,
    );
    const stop = getByRole("button", { name: "Stop now" });
    const stopCalls = () =>
      fetchMock.mock.calls.filter(
        (call) => String(call[0]) === "/api/projects/monday-digest/runs/1/stop",
      );

    // Declined: nothing is stopped. A kill must not happen on one stray tap.
    fireEvent.click(stop);
    let dialog = await screen.findByRole("dialog", { name: "Stop this run now?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(stopCalls()).toHaveLength(0);

    fireEvent.click(stop);
    dialog = await screen.findByRole("dialog", { name: "Stop this run now?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Stop now" }));
    await waitFor(() => expect(stopCalls()).toHaveLength(1));
  });

  it("is not offered once the run is over", () => {
    const { queryByRole } = render(
      <RunView slug="monday-digest" run={RUN({ status: "done" })} />,
    );
    expect(queryByRole("button", { name: "Stop now" })).toBeNull();
  });
});

describe("RunView on a supervised checkpoint hold", () => {
  it("offers Continue while the row still says running", () => {
    const { getByRole, getByText } = render(
      <RunView
        slug="monday-digest"
        run={RUN({ status: "running", awaiting_continue: true })}
      />,
    );
    expect(getByRole("button", { name: "Continue" })).toBeTruthy();
    expect(getByText(/checkpoint step's work below/i)).toBeTruthy();
  });

  it("quotes the checkpoint card's own comment, links straight to it, and lists the held card(s) to answer in", () => {
    const { getByText, getByRole, getAllByRole } = render(
      <RunView
        slug="monday-digest"
        run={RUN({
          status: "running",
          awaiting_continue: true,
          cards: [
            { task_id: "t_pricing", step_key: "pricing", status: "done", title: "Draft pricing for all 7 items", attempts: 1, failed_attempts: 0, last_error: null, last_outcome: null },
            { task_id: "t_proposal", step_key: "proposal", status: "triage", title: "Draft the service proposal", attempts: 0, failed_attempts: 0, last_error: null, last_outcome: null },
          ],
          checkpoint_wait: {
            checkpoint_task_id: "t_pricing",
            checkpoint_title: "Draft pricing for all 7 items",
            comment: "Pricing drafted — HK$609,200 total. Does the company already own the headsets?",
            held_task_ids: ["t_proposal"],
          },
        })}
      />,
    );
    expect(getByText(/"Draft pricing for all 7 items" is done/i)).toBeTruthy();
    expect(getByText(/Does the company already own the headsets/i)).toBeTruthy();
    const link = getByRole("link", { name: "Open the checkpoint card" });
    expect(link.getAttribute("href")).toBe(
      "/projects/monday-digest/cards/t_pricing",
    );
    // Also rendered by the ordinary card list further down the page —
    // any match having the right href is enough.
    const heldLinks = getAllByRole("link", { name: "Draft the service proposal" });
    expect(
      heldLinks.some(
        (l) => l.getAttribute("href") === "/projects/monday-digest/cards/t_proposal",
      ),
    ).toBe(true);
  });

  it("keeps Continue away from a running run without a hold", () => {
    const { queryByRole } = render(
      <RunView slug="monday-digest" run={RUN({ status: "running" })} />,
    );
    expect(queryByRole("button", { name: "Continue" })).toBeNull();
  });
});

describe("RunView live visuals", () => {
  const cards = [
    { task_id: "t1", step_key: "research", status: "done", title: "Research", attempts: 1, failed_attempts: 0, last_error: null, last_outcome: null },
    {
      task_id: "t2", step_key: "design", status: "running", title: "Design",
      attempts: 2, failed_attempts: 1,
      last_error: "worker exited cleanly (rc=0) without calling kanban_complete or kanban_block — protocol violation",
      last_outcome: "crashed",
    },
    { task_id: "t3", step_key: "review", status: "triage", title: "Review", attempts: 0, failed_attempts: 0, last_error: null, last_outcome: null },
  ];

  it("shows a green animated Running badge, the % bar and per-step state", () => {
    const { container, getByText, getByRole } = render(
      <RunView
        slug="p"
        run={RUN({ status: "running", cards, completion_percent: 50 })}
      />,
    );
    const badge = container.querySelector('[data-component="RunStatusBadge"]');
    expect(badge?.textContent).toContain("Running");
    expect(badge?.className).toMatch(/emerald/);
    expect(badge?.querySelector(".animate-ping")).toBeTruthy();
    expect(getByRole("progressbar").getAttribute("aria-valuenow")).toBe("50");
    expect(getByText("50%")).toBeTruthy();
    expect(getByText(/1 of 3 steps done · 1 working/)).toBeTruthy();
    expect(container.querySelector('[data-status="running"] .animate-ping')).toBeTruthy();
    expect(getByText(/held — released on Continue/)).toBeTruthy();
    // The retry is named, with its reason, not hidden behind "running".
    expect(getByText(/One step crashed and was retried/)).toBeTruthy();
    expect(getByText(/protocol violation/)).toBeTruthy();
    expect(getByText(/attempt 2, 1 crashed/)).toBeTruthy();
  });

  it("derives the % client-side when the server omits it", () => {
    const { getByRole } = render(
      <RunView slug="p" run={RUN({ status: "running", cards })} />,
    );
    // done 1 + running 0.5 = 1.5 / 3
    expect(getByRole("progressbar").getAttribute("aria-valuenow")).toBe("50");
  });

  it("reads red Failed with no animation, and grey Stopped for cancelled", () => {
    const failed = render(
      <RunView slug="p" run={RUN({ status: "failed", ended_at: NOW, cards: [] })} />,
    );
    const badge = failed.container.querySelector('[data-component="RunStatusBadge"]');
    expect(badge?.textContent).toContain("Failed");
    expect(badge?.className).toMatch(/red/);
    expect(badge?.querySelector(".animate-ping")).toBeNull();
    failed.unmount();

    const stopped = render(
      <RunView slug="p" run={RUN({ status: "cancelled", ended_at: NOW })} />,
    );
    expect(
      stopped.container.querySelector('[data-component="RunStatusBadge"]')?.textContent,
    ).toContain("Stopped");
  });
});

describe("RunView resume — continue, never restart from scratch", () => {
  it("offers Resume (not just Repeat) on a failed run, and posts to the resume verb", async () => {
    const fetchMock = vi.fn(
      async () =>
        ({
          ok: true,
          json: async () => ({ run: { status: "running" }, promoted: ["t_2"] }),
        }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);

    const { getByRole } = render(
      <RunView
        slug="monday-digest"
        run={RUN({ status: "failed", ended_at: NOW, error: "stalled" })}
      />,
    );
    expect(getByRole("button", { name: "Resume" })).toBeTruthy();
    // Repeat is still offered, just relabelled and de-emphasised so Resume
    // reads as the primary choice.
    expect(getByRole("button", { name: "Start over instead" })).toBeTruthy();

    fireEvent.click(getByRole("button", { name: "Resume" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/projects/monday-digest/runs/1/resume",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("offers Resume on a cancelled run too", () => {
    const { getByRole } = render(
      <RunView
        slug="monday-digest"
        run={RUN({ status: "cancelled", ended_at: NOW })}
      />,
    );
    expect(getByRole("button", { name: "Resume" })).toBeTruthy();
  });

  it("does not offer Resume on a finished run — Repeat keeps its plain label", () => {
    const { queryByRole, getByRole } = render(
      <RunView
        slug="monday-digest"
        run={RUN({ status: "done", ended_at: NOW })}
      />,
    );
    expect(queryByRole("button", { name: "Resume" })).toBeNull();
    expect(getByRole("button", { name: "Repeat this run" })).toBeTruthy();
  });

  it("warns before starting over when Resume was also on offer", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { getByRole } = render(
      <RunView
        slug="monday-digest"
        run={RUN({ status: "failed", ended_at: NOW })}
      />,
    );
    fireEvent.click(getByRole("button", { name: "Start over instead" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(/redoes every step/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not offer Resume on an archived project", () => {
    const { queryByRole } = render(
      <RunView
        slug="monday-digest"
        run={RUN({ status: "failed", ended_at: NOW })}
        archived
      />,
    );
    expect(queryByRole("button", { name: "Resume" })).toBeNull();
  });
});

describe("RunView next-action clarity", () => {
  it("flags a failed run with a still-active card instead of just saying Failed", () => {
    const run = RUN({
      status: "failed",
      ended_at: NOW,
      error: "no card or session progressed this run for over 2h",
      cards: [
        { task_id: "t_1", step_key: "slides", status: "running", title: "Execute prompts" },
      ],
    });
    const { getByText, container } = render(
      <RunView slug="monday-digest" run={run} />,
    );
    expect(container.querySelector('[data-component="RunStatusBadge"]')?.textContent).toContain(
      "Failed",
    );
    expect(
      getByText(/a card is still actively working/),
    ).toBeTruthy();
  });

  it("tells you to tap Resume when a failed run has nothing left running", () => {
    const run = RUN({ status: "failed", ended_at: NOW, cards: [] });
    const { getByText } = render(<RunView slug="monday-digest" run={run} />);
    expect(getByText(/continue from exactly where it left off/)).toBeTruthy();
  });

  it("points straight at a blocked card needing a decision", () => {
    const run = RUN({
      status: "running",
      cards: [
        { task_id: "t_1", step_key: "slides", status: "blocked", title: "Execute prompts in Canva" },
      ],
    });
    const { getByText } = render(<RunView slug="monday-digest" run={run} />);
    expect(getByText(/"Execute prompts in Canva" is blocked and needs you/)).toBeTruthy();
  });

  it("says no action is needed on a healthy running run", () => {
    const run = RUN({
      status: "running",
      cards: [{ task_id: "t_1", step_key: "draft", status: "running", title: "Draft" }],
    });
    const { getByText } = render(<RunView slug="monday-digest" run={run} />);
    expect(getByText(/no action needed right now/)).toBeTruthy();
  });
});
