// @vitest-environment jsdom
/**
 * Every stop in the live bar goes through `useProjectAction`: one request
 * however fast the clicks, a pending label while in flight, the confirmed
 * state after, and an error with a working retry on failure. Stop all maps
 * "Stop now" to `/runs/{n}/stop` (terminates workers) and "Finish current
 * steps, then stop" to `/runs/{n}/cancel` (lets running workers finish).
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/projects", useRouter: () => router }));

import { IDEMPOTENCY_HEADER } from "@/components/projects/useProjectAction";
import type { ProjectBoardTask, ProjectBoardView, ProjectDetail } from "@/types";

import { LiveStatusBar } from "./LiveStatusBar";

const NOW = Math.floor(Date.now() / 1000);

const PROJECT = {
  id: "prj_1",
  slug: "mou",
  name: "Prepare the MOUs",
  status: "active",
  archived: false,
  host_profile: "default",
  runs: [
    {
      run_no: 3,
      status: "running",
      trigger: "manual",
      started_at: NOW - 720,
      ended_at: null,
      duration_seconds: null,
      outcome: null,
      score_user: null,
    },
  ],
  card_rollup: { total: 7, done: 3, running: 2, blocked: 0 },
} as unknown as ProjectDetail;

const CARD = (id: string, title: string): ProjectBoardTask => ({
  id,
  title,
  body: null,
  status: "running",
  assignee: "default",
  priority: 0,
  created_at: NOW - 3_600,
  started_at: NOW - 300,
  completed_at: null,
  tenant: null,
  project_id: "prj_1",
  result: null,
  current_step_key: null,
});

const BOARD: ProjectBoardView = {
  columns: [{ name: "running", tasks: [CARD("t1", "Draft one"), CARD("t2", "Draft two")] }],
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

type Call = { url: string; init?: RequestInit };
let posts: Call[];
let answer: (url: string) => Promise<Response>;

beforeEach(() => {
  posts = [];
  answer = async () => json(200, { ok: true });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push({ url, init });
        return answer(url);
      }
      // Live streams are not under test here.
      return json(404, { detail: "not found" });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  router.refresh.mockReset();
});

function rowButton(taskId: string): HTMLButtonElement {
  const row = document.querySelector(`[data-task-id="${taskId}"]`)!;
  return row.querySelector("button")! as HTMLButtonElement;
}

describe("Stop on one task", () => {
  it("double click sends one POST, shows Stopping…, then Stopped by you", async () => {
    const gate = deferred<Response>();
    answer = () => gate.promise;
    render(<LiveStatusBar project={PROJECT} board={BOARD} />);
    const button = rowButton("t1");
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe("/api/projects/mou/cards/t1/stop");
    expect((posts[0].init?.headers as Record<string, string>)[IDEMPOTENCY_HEADER]).toBeTruthy();
    await waitFor(() => expect(rowButton("t1").disabled).toBe(true));
    expect(rowButton("t1").textContent).toContain("Stopping…");
    // The other row locks independently.
    expect(rowButton("t2").disabled).toBe(false);
    await act(async () => gate.resolve(json(200, { ok: true, task_id: "t1" })));
    await waitFor(() =>
      expect(
        document.querySelector('[data-task-id="t1"] [data-component="StoppedPill"]')?.textContent,
      ).toContain("Stopped by you"),
    );
    expect(router.refresh).toHaveBeenCalled();
  });

  it("a refusal shows the error and re-enables the button; retry resends the same key", async () => {
    answer = async () => json(409, { detail: "the card cannot be stopped right now" });
    render(<LiveStatusBar project={PROJECT} board={BOARD} />);
    fireEvent.click(rowButton("t1"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBeTruthy();
    expect(rowButton("t1").disabled).toBe(false);
    expect(document.querySelector('[data-task-id="t1"] [data-component="StoppedPill"]')).toBeNull();
    answer = async () => json(200, { ok: true });
    fireEvent.click(screen.getByText("Try again"));
    await waitFor(() => expect(posts).toHaveLength(2));
    const key = (c: Call) => (c.init?.headers as Record<string, string>)[IDEMPOTENCY_HEADER];
    expect(key(posts[1])).toBe(key(posts[0]));
    await waitFor(() =>
      expect(document.querySelector('[data-task-id="t1"] [data-component="StoppedPill"]')).not.toBeNull(),
    );
  });
});

describe("Stop all", () => {
  function openDialog() {
    fireEvent.click(screen.getByText("■ Stop all"));
    return screen.getByRole("dialog");
  }

  it("Keep running closes the dialog and sends nothing", () => {
    render(<LiveStatusBar project={PROJECT} board={BOARD} />);
    const dialog = openDialog();
    expect(dialog.textContent).toContain("Stop run 3?");
    expect(dialog.textContent).toContain("2 tasks are running.");
    fireEvent.click(screen.getByText("Keep running"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(posts).toHaveLength(0);
  });

  it("Stop now posts /runs/3/stop once, shows Stopping…, then Stopped", async () => {
    const gate = deferred<Response>();
    answer = () => gate.promise;
    render(<LiveStatusBar project={PROJECT} board={BOARD} />);
    openDialog();
    const confirm = screen.getByText("Stop run 3").closest("button")!;
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(posts.map((p) => p.url)).toEqual(["/api/projects/mou/runs/3/stop"]);
    await waitFor(() => expect(confirm.disabled).toBe(true));
    expect(confirm.textContent).toContain("Stopping run 3…");
    expect(document.querySelector('[data-component="LiveStatusBar"]')!.getAttribute("data-state")).toBe(
      "stopping",
    );
    await act(async () => gate.resolve(json(200, { run_no: 3, status: "cancelled" })));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.querySelector('[data-component="LiveStatusBar"]')!.getAttribute("data-state")).toBe(
      "stopped",
    );
    expect(document.querySelectorAll('[data-component="StoppedPill"]')).toHaveLength(2);
  });

  it("Finish current steps, then stop posts /runs/3/cancel", async () => {
    render(<LiveStatusBar project={PROJECT} board={BOARD} />);
    openDialog();
    fireEvent.click(screen.getByLabelText(/Finish current steps, then stop/));
    fireEvent.click(screen.getByText("Stop run 3").closest("button")!);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posts.map((p) => p.url)).toEqual(["/api/projects/mou/runs/3/cancel"]);
    // Running steps still finish: the bar says Stopping… not Stopped.
    expect(document.querySelector('[data-component="LiveStatusBar"]')!.getAttribute("data-state")).toBe(
      "stopping",
    );
  });

  it("a failure keeps the dialog open with the error and a working retry", async () => {
    answer = async () => json(500, { detail: "boom" });
    render(<LiveStatusBar project={PROJECT} board={BOARD} />);
    openDialog();
    const confirm = screen.getByText("Stop run 3").closest("button")!;
    fireEvent.click(confirm);
    await screen.findByRole("alert");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(confirm.disabled).toBe(false);
    expect(document.querySelector('[data-component="LiveStatusBar"]')!.getAttribute("data-state")).toBe(
      "working",
    );
    answer = async () => json(200, { ok: true });
    fireEvent.click(screen.getByText("Try again"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posts.map((p) => p.url)).toEqual([
      "/api/projects/mou/runs/3/stop",
      "/api/projects/mou/runs/3/stop",
    ]);
  });
});

describe("the resting buttons", () => {
  it("Start next iteration posts once with a pending label", async () => {
    const gate = deferred<Response>();
    answer = () => gate.promise;
    render(
      <LiveStatusBar project={{ ...PROJECT, runs: [] } as ProjectDetail} board={{ columns: [] }} />,
    );
    const start = screen.getByText("▶ Start next iteration").closest("button")!;
    fireEvent.click(start);
    fireEvent.click(start);
    expect(posts.map((p) => p.url)).toEqual(["/api/projects/mou/runs"]);
    await waitFor(() => expect(start.textContent).toContain("Starting…"));
    expect(start.disabled).toBe(true);
    await act(async () => gate.resolve(json(201, { run: { run_no: 4 } })));
    await waitFor(() => expect(start.disabled).toBe(false));
    expect(router.refresh).toHaveBeenCalled();
  });
});

describe("collapsing", () => {
  it("folds to one line when scrolled and opens again on tap", async () => {
    render(<LiveStatusBar project={PROJECT} board={BOARD} />);
    const bar = () => document.querySelector('[data-component="LiveStatusBar"]')!;
    expect(bar().getAttribute("data-collapsed")).toBeNull();
    await act(async () => {
      Object.defineProperty(window, "scrollY", { value: 900, configurable: true });
      window.dispatchEvent(new Event("scroll"));
    });
    expect(bar().getAttribute("data-collapsed")).toBe("true");
    expect(document.querySelector('[data-component="LiveTaskRow"]')).toBeNull();
    expect(screen.getByText("■ Stop all")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(bar().getAttribute("data-collapsed")).toBeNull();
    Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
  });
});
