// @vitest-environment jsdom
/**
 * Handler-level tests for the Projects write affordances added for items
 * 7–11: Run now lands on the new run page, RunsPanel's inline controls hit
 * the run routes, the card editor / board send one PATCH per change, a
 * per-column New card creates-then-moves, and Summarise posts the rolling
 * summary.
 */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects",
  useRouter: () => router,
}));

import { CardEditor } from "@/components/projects/CardEditor";
import { SummariseSheet } from "@/components/projects/SummariseSheet";
import { cardMoves, cardPatch } from "@/components/projects/cardMoves";
import { BoardPanel } from "@/components/projects/panels/BoardPanel";
import { RunsPanel, isLiveRun } from "@/components/projects/panels/RunsPanel";
import type { ProjectBoardView, ProjectCardDetail, ProjectRunBrief } from "@/types";

const NOW = Math.floor(Date.now() / 1000);

const CARD: ProjectCardDetail = {
  id: "task_1",
  title: "Draft the digest",
  body: "Pull the threads.",
  status: "todo",
  assignee: null,
  priority: 3,
  created_at: NOW - 86_400,
  started_at: null,
  completed_at: null,
  tenant: null,
  project_id: "prj_1",
  result: null,
  current_step_key: null,
  age: null,
};

const RUN: ProjectRunBrief = {
  run_no: 14,
  status: "waiting",
  trigger: "schedule",
  started_at: NOW - 7_200,
  ended_at: null,
  duration_seconds: null,
  outcome: null,
  score_user: null,
};

const BOARD: ProjectBoardView = {
  columns: [
    { name: "triage", tasks: [] },
    { name: "todo", tasks: [CARD] },
    { name: "ready", tasks: [] },
  ],
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  router.push.mockClear();
  router.refresh.mockClear();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sentJson(call: unknown[]): Record<string, unknown> {
  const init = call[1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe("cardMoves", () => {
  it("never offers the dispatcher's columns as a target", () => {
    for (const status of ["triage", "todo", "ready", "running", "blocked", "done"]) {
      const targets = cardMoves(status).map((m) => m.to);
      expect(targets).not.toContain("running");
      expect(targets).not.toContain("review");
      expect(targets).not.toContain("scheduled");
      expect(targets).not.toContain("todo");
      expect(targets).not.toContain(status);
    }
    expect(cardMoves("archived")).toEqual([]);
  });

  it("cardPatch only sends what changed, and null to unassign", () => {
    const before = { title: "A", body: "b", assignee: "worker" };
    expect(cardPatch(before, { ...before })).toEqual({});
    expect(cardPatch(before, { ...before, title: " A2 " })).toEqual({ title: "A2" });
    expect(cardPatch(before, { ...before, assignee: "" })).toEqual({ assignee: null });
  });
});

describe("RunsPanel controls", () => {
  it("isLiveRun covers running / waiting / blocked only", () => {
    expect(isLiveRun("running")).toBe(true);
    expect(isLiveRun("waiting")).toBe(true);
    expect(isLiveRun("blocked")).toBe(true);
    expect(isLiveRun("done")).toBe(false);
    expect(isLiveRun("cancelled")).toBe(false);
  });

  it("Continue posts to the run's continue route and refreshes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const { getByText } = render(<RunsPanel slug="monday-digest" runs={[RUN]} />);
    fireEvent.click(getByText("Continue"));

    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/projects/monday-digest/runs/14/continue",
    );
  });

  it("surfaces the upstream refusal inline", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(409, { detail: "run 14 is not waiting" })),
    );

    const { getByText, findByRole } = render(
      <RunsPanel slug="monday-digest" runs={[RUN]} />,
    );
    fireEvent.click(getByText("Cancel"));

    // The 409 is translated into what to do, not echoed verbatim.
    expect((await findByRole("alert")).textContent).toContain(
      "not waiting for you any more",
    );
    expect(router.refresh).not.toHaveBeenCalled();
  });
});

describe("CardEditor", () => {
  it("saves title/brief/assignee as one PATCH of only the changed fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ...CARD, title: "New" }));
    vi.stubGlobal("fetch", fetchMock);

    const { getByText, getByLabelText } = render(
      <CardEditor slug="monday-digest" card={CARD} profiles={["default", "worker"]} />,
    );
    fireEvent.click(getByText("Edit card"));
    fireEvent.change(getByLabelText("Title"), { target: { value: "New" } });
    fireEvent.change(getByLabelText("Worked by"), { target: { value: "worker" } });
    fireEvent.click(getByText("Save"));

    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/projects/monday-digest/cards/task_1");
    expect((init as RequestInit).method).toBe("PATCH");
    expect(sentJson(fetchMock.mock.calls[0])).toEqual({ title: "New", assignee: "worker" });
  });

  it("moves the card with a status PATCH and shows a refused move", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(409, { detail: "the card cannot be made ready from here" }));
    vi.stubGlobal("fetch", fetchMock);

    const { getByLabelText, findByRole } = render(
      <CardEditor slug="monday-digest" card={CARD} profiles={[]} />,
    );
    fireEvent.change(getByLabelText("Move card"), { target: { value: "ready" } });

    expect(sentJson(fetchMock.mock.calls[0])).toEqual({ status: "ready" });
    expect((await findByRole("alert")).textContent).toContain("cannot be made ready");
  });
});

describe("BoardPanel writes", () => {
  it("New card in a non-triage column creates then moves it there", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(201, { task_id: "task_9", status: "triage" }))
      .mockResolvedValueOnce(jsonResponse(200, { id: "task_9", status: "ready" }));
    vi.stubGlobal("fetch", fetchMock);

    const { getAllByText, getByLabelText, getByText } = render(
      <BoardPanel slug="monday-digest" board={BOARD} />,
    );
    // triage / ready are startable — the second is ready.
    fireEvent.click(getAllByText("+ New card")[1]);
    fireEvent.change(getByLabelText("New card in ready"), {
      target: { value: "Ship it" },
    });
    fireEvent.click(getByText("Create"));

    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/projects/monday-digest/cards");
    expect(sentJson(fetchMock.mock.calls[0])).toEqual({ title: "Ship it" });
    expect(fetchMock.mock.calls[1][0]).toBe("/api/projects/monday-digest/cards/task_9");
    expect(sentJson(fetchMock.mock.calls[1])).toEqual({ status: "ready" });
  });

  it("a row move sends one status PATCH", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ...CARD, status: "ready" }));
    vi.stubGlobal("fetch", fetchMock);

    const { getByLabelText } = render(<BoardPanel slug="monday-digest" board={BOARD} />);
    fireEvent.change(getByLabelText("Move Draft the digest"), { target: { value: "ready" } });

    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/projects/monday-digest/cards/task_1");
    expect(sentJson(fetchMock.mock.calls[0])).toEqual({ status: "ready" });
  });
});

describe("SummariseSheet", () => {
  it("posts the summary and closes on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { summary_at: NOW }));
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();

    const { getByRole, getByText } = render(
      <SummariseSheet slug="monday-digest" initial="" onClose={onClose} />,
    );
    fireEvent.change(getByRole("textbox"), { target: { value: "Run 14 is waiting on tone." } });
    fireEvent.click(getByText("Save summary"));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/projects/monday-digest/summarise");
    expect(sentJson(fetchMock.mock.calls[0])).toEqual({ summary: "Run 14 is waiting on tone." });
  });
});
