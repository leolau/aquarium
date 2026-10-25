// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
// The shelf reads artifacts on mount; it has its own tests (Outputs workstream).
vi.mock("@/components/projects/outputs/LatestOutputsShelf", () => ({ LatestOutputsShelf: () => null }));

import { ReadinessChecklist } from "@/components/projects/ReadinessChecklist";
import {
  NOW,
  board,
  card,
  playbook,
  project,
  run,
} from "@/components/projects/dashboard/__fixtures__/dashboard";
import { DashboardTab } from "@/components/projects/tabs/DashboardTab";
import type { ProjectTabProps } from "@/components/projects/tabs/types";
import { IDEMPOTENCY_HEADER } from "@/components/projects/useProjectAction";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  router.push.mockClear();
  router.refresh.mockClear();
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function props(over: Partial<ProjectTabProps> = {}): ProjectTabProps {
  return {
    project: project({ runs: [run({ run_no: 2, started_at: NOW - 3_600 })] }),
    board: board(
      card({ id: "t1", status: "triage", title: "Produce MOUs", created_by: "default" }),
      card({ id: "t2", status: "triage", title: "Upload set", created_by: "default" }),
    ),
    playbook: playbook(),
    directives: null,
    doctor: null,
    callerUserId: "yan",
    canLead: true,
    readiness: [],
    runnable: true,
    onNavigate: vi.fn(),
    onChangeRequest: vi.fn(),
    ...over,
  };
}

const APPROVE = "Approve 2 cards & resume work";

function call(fetchMock: ReturnType<typeof vi.fn>, i: number) {
  const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit];
  const headers = init.headers as Record<string, string>;
  return { url, method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined, key: headers[IDEMPOTENCY_HEADER] };
}

describe("Approve N cards & resume work", () => {
  it("one click → each card PATCHed to ready, then one run POST; double click → still one set", async () => {
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(url.endsWith("/runs") ? json(201, { run: { run_no: 3 } }) : json(200, { status: "ready" })),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<DashboardTab {...props()} />);

    const button = screen.getByRole("button", { name: APPROVE });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(await screen.findByRole("status", {}, { timeout: 5000 })).toHaveProperty("textContent", "Approved 2 cards. Run 3 started.");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect([0, 1, 2].map((i) => {
      const c = call(fetchMock, i);
      return [c.method, c.url, c.body];
    })).toEqual([
      ["PATCH", "/api/projects/mou-set/cards/t1", { status: "ready" }],
      ["PATCH", "/api/projects/mou-set/cards/t2", { status: "ready" }],
      ["POST", "/api/projects/mou-set/runs", undefined],
    ]);
    const keys = [0, 1, 2].map((i) => call(fetchMock, i).key);
    expect(new Set(keys).size).toBe(3);
    // Only the last request refreshes the page.
    expect(router.refresh).toHaveBeenCalledTimes(1);
    // Confirmed: the button can't be pressed again. It stays busy until the
    // refresh transition lands, which can render after the status line.
    fireEvent.click(await screen.findByRole("button", { name: "Done ✓" }, { timeout: 5000 }));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("shows the pending label and stays disabled across every request", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValueOnce(json(201, { run: { run_no: 3 } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<DashboardTab {...props()} />);

    fireEvent.click(screen.getByRole("button", { name: APPROVE }));
    const pending = await screen.findByRole("button", { name: "Approving…" }, { timeout: 5000 });
    expect((pending as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(pending);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => first.resolve(json(200, {})));
    expect(screen.getByRole("button", { name: "Approving…" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Approving…" }));
    await act(async () => second.resolve(json(200, {})));

    await screen.findByRole("status", {}, { timeout: 5000 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("failure shows the error, re-enables, and Try again re-sends the same key then carries on", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(500, { detail: "boom" }))
      .mockResolvedValueOnce(json(200, {}))
      .mockResolvedValueOnce(json(200, {}))
      .mockResolvedValueOnce(json(201, { run: { run_no: 3 } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<DashboardTab {...props()} />);

    fireEvent.click(screen.getByRole("button", { name: APPROVE }));
    expect(await screen.findByRole("alert", {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByRole("button", { name: APPROVE })).toHaveProperty("disabled", false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(router.refresh).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("status", {}, { timeout: 5000 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(call(fetchMock, 1).url).toBe("/api/projects/mou-set/cards/t1");
    expect(call(fetchMock, 1).key).toBe(call(fetchMock, 0).key);
    expect(call(fetchMock, 2).url).toBe("/api/projects/mou-set/cards/t2");
    expect(call(fetchMock, 3).url).toBe("/api/projects/mou-set/runs");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("with a run already open, approves without starting another", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, {}));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <DashboardTab
        {...props({
          project: project({ runs: [run({ run_no: 2, status: "running", started_at: NOW - 7_200, ended_at: null })] }),
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: APPROVE }));
    await screen.findByRole("status", {}, { timeout: 5000 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes("/cards/"))).toBe(true);
  });
});

describe("other Dashboard buttons", () => {
  it("Continue run: double click sends one POST and confirms", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <DashboardTab
        {...props({ project: project({ runs: [run({ run_no: 4, status: "waiting", ended_at: null })] }), board: board() })}
      />,
    );
    const button = screen.getByRole("button", { name: "Continue run 4" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(await screen.findByRole("status", {}, { timeout: 5000 })).toHaveProperty("textContent", "Run 4 is going again.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(call(fetchMock, 0).url).toBe("/api/projects/mou-set/runs/4/continue");
  });

  it("per-row buttons lock independently", async () => {
    const hold = deferred<Response>();
    const fetchMock = vi.fn().mockReturnValueOnce(hold.promise).mockResolvedValue(json(200, {}));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <DashboardTab
        {...props({
          project: project({ runs: [run()] }),
          board: board(
            card({ id: "b1", status: "blocked", title: "One", priority: 2 }),
            card({ id: "b2", status: "blocked", title: "Two", priority: 1 }),
          ),
        })}
      />,
    );
    // b1 is the hero; b2's row has its own Retry.
    const [heroRetry, rowRetry] = screen.getAllByRole("button", { name: "Retry" });
    fireEvent.click(heroRetry);
    expect(await screen.findByRole("button", { name: "Retrying…" }, { timeout: 5000 })).toBeTruthy();
    expect(rowRetry).toHaveProperty("disabled", false);
    fireEvent.click(rowRetry);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(call(fetchMock, 1).url).toBe("/api/projects/mou-set/cards/b2");
    await act(async () => hold.resolve(json(200, {})));
  });

  it("navigation items switch tab; the change button opens the change box", () => {
    const p = props({ project: project({ runs: [run()], links: {} }), board: board() });
    render(<DashboardTab {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Add inputs" }));
    expect(p.onNavigate).toHaveBeenCalledWith("inputs");
    fireEvent.click(screen.getByRole("button", { name: "History ›" }));
    expect(p.onNavigate).toHaveBeenCalledWith("iterations");
    fireEvent.click(screen.getByRole("button", { name: "Iterations ›" }));
    fireEvent.click(screen.getByRole("button", { name: "Tell the agent what to change" }));
    expect(p.onChangeRequest).toHaveBeenCalledTimes(1);
  });
});

describe("ReadinessChecklist", () => {
  const items = [
    { key: "outputs" as const, label: "At least one output", ok: false, hint: "Declare what the project delivers.", anchor: "?tab=outputs", tab: "outputs" as const },
  ];

  it("switches tab in place when onNavigate is given", () => {
    const onNavigate = vi.fn();
    render(<ReadinessChecklist items={items} findings={[]} onNavigate={onNavigate} />);
    const anchor = screen.getByText("Declare what the project delivers.");
    expect(anchor.getAttribute("href")).toBe("?tab=outputs");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    anchor.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(onNavigate).toHaveBeenCalledWith("outputs");
  });

  it("is a plain ?tab= link without onNavigate", () => {
    render(<ReadinessChecklist items={items} findings={[]} />);
    const anchor = screen.getByText("Declare what the project delivers.");
    expect(anchor.getAttribute("href")).toBe("?tab=outputs");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    anchor.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
