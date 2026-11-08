// @vitest-environment jsdom
/**
 * The change sheet's writes: each apply mode hits the right route, the draft
 * is polled into a diff, and every button follows pending → confirmed or
 * failed → retry with exactly one request per click.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/mou-set/runs/2", useRouter: () => router }));

import { ChangeRequestSheet } from "@/components/projects/changes/ChangeRequestSheet";
import { IDEMPOTENCY_HEADER } from "@/components/projects/useProjectAction";
import {
  DRAFT_STEPS,
  playbook,
  project,
  run,
} from "@/components/projects/changes/testFixtures";
import type { ProjectChangeApply, ProjectDetail } from "@/types";

const BASE = "/api/projects/mou-set";

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

type Call = { url: string; method: string; body: unknown; key: string | undefined };

const CHANGE = {
  id: "d_9",
  project_id: "prj_1",
  kind: "directive",
  body: "Split goes to 3%",
  scope: "project",
  target_ref: null,
  rating: null,
  author_user_id: "leo",
  created_at: 1,
  active: 1,
  retired_at: null,
  superseded_by: null,
  kinds: ["direction"],
  apply: "next",
  is_change: true,
  stopped_run: null,
  draft_rev: null,
  reading: null,
  approved: null,
};

const READING = {
  changes: ["revenue split"],
  affected_outputs: [{ id: "o1", title: "4 MOUs" }],
  supersedes: [{ id: "d_1", body: "Split 2.5%" }],
};

/** A fake BFF: records every call; per-route handlers may be overridden. */
function server(
  over: Partial<Record<string, (call: Call) => Response | Promise<Response>>> = {},
  draftStates: unknown[] = [{ status: "running" }, { status: "done", rev: 2, reading: READING }],
) {
  const calls: Call[] = [];
  const queue = [...draftStates];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = {
      url,
      method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      key: headers[IDEMPOTENCY_HEADER],
    };
    calls.push(call);
    const route = `${method} ${url.replace(BASE, "")}`;
    if (over[route]) return over[route]!(call);
    switch (route) {
      case "POST /changes": {
        const apply = (call.body as { apply: ProjectChangeApply }).apply;
        return json(200, {
          change: { ...CHANGE, apply },
          draft: { status: apply === "record" ? "idle" : "running" },
          stopped_run: apply === "now" ? 1 : null,
        });
      }
      case "GET /playbook/draft":
        return json(200, queue.length > 1 ? queue.shift() : queue[0]);
      case "GET /playbook": {
        const book = playbook();
        return json(200, {
          active: book.active,
          revisions: [...book.revisions, { ...book.active!, rev: 2, active: 0, steps: DRAFT_STEPS }],
        });
      }
      case "POST /changes/d_9/approve": {
        const body = call.body as { rev: number; start?: boolean };
        return json(200, {
          change: CHANGE,
          rev: body.rev,
          active: true,
          run: body.start === false ? null : { run_no: 2 },
          superseded: [],
        });
      }
      case "POST /changes/d_9/draft":
        return json(200, { change: CHANGE, draft: { status: "running" } });
      default:
        return json(404, { detail: `unexpected ${route}` });
    }
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

function renderSheet(p: ProjectDetail = project({ runs: [run(1)] }), onClose = vi.fn()) {
  render(
    <ChangeRequestSheet
      project={p}
      playbook={playbook()}
      directives={null}
      initialText="Split goes to 3%"
      onClose={onClose}
      pollMs={5}
    />,
  );
  return onClose;
}

const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");

async function sendWith(label: RegExp, submit: RegExp) {
  fireEvent.click(screen.getByLabelText(label));
  fireEvent.click(screen.getByRole("button", { name: submit }));
}

async function reachDiff(apply: RegExp = /Queue for the next iteration/) {
  await sendWith(apply, /Redraft the plan|Pause run/);
  await screen.findByRole("button", { name: /Approve & start iteration/ });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  router.push.mockReset();
  router.refresh.mockReset();
});

describe("ChangeRequestSheet — apply modes", () => {
  it("Just record it: one POST /changes, no draft, nothing started", async () => {
    const { calls } = server();
    renderSheet();
    fireEvent.click(screen.getByRole("button", { name: /Change direction/ }));
    await sendWith(/Just record it/, /Save requirement/);
    await screen.findByText(/Saved as a requirement/);
    expect(writes(calls)).toHaveLength(1);
    expect(calls[0].body).toEqual({ text: "Split goes to 3%", kinds: ["direction"], apply: "record" });
    expect(calls[0].key).toBeTruthy();
    expect(calls.some((c) => c.url.includes("/playbook"))).toBe(false);
    expect(screen.queryByText(/Agent’s updated plan/)).toBeNull();
  });

  it("Queue for the next iteration: drafts, polls, then shows the diff and the reading", async () => {
    const { calls } = server();
    renderSheet();
    await sendWith(/Queue for the next iteration/, /Redraft the plan/);
    expect(await screen.findByText(/drafting the updated plan/)).toBeTruthy();
    await screen.findByRole("button", { name: /Approve & start iteration 2/ });
    expect((calls[0].body as { apply: string }).apply).toBe("next");
    expect(calls.filter((c) => c.url === `${BASE}/playbook/draft`).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("rev 2 ready")).toBeTruthy();
    const removed = document.querySelector('[data-diff="removed"]');
    expect(removed?.textContent).toContain("Upload the set");
    expect(removed?.className).toContain("line-through");
    expect(document.querySelector('[data-diff="added"]')?.textContent).toContain("Review checkpoint");
    expect(document.querySelector('[data-diff="changed"]')?.textContent).toContain("Re-draft each MOU");
    expect(screen.getByTestId("agent-reading").textContent).toContain(
      "1 requirement change (revenue split) · affects output “4 MOUs” · supersedes “Split 2.5%”",
    );
    expect(writes(calls)).toHaveLength(1);
  });

  it("Pause run N and apply now: sends apply=now and reports the stopped run", async () => {
    const { calls } = server();
    renderSheet(project({ runs: [run(1, { status: "running", ended_at: null })] }));
    expect((screen.getByLabelText(/Pause run 1 and apply now/) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Pause run 1 and redraft the plan/ }));
    await screen.findByText(/Run 1 was stopped. Its finished work is kept./);
    expect((calls[0].body as { apply: string }).apply).toBe("now");
    await screen.findByRole("button", { name: /Approve & start iteration 2/ });
  });

  it("Apply now without an open run is offered as 'start iteration N+1'", async () => {
    const { calls } = server({
      "POST /changes": () =>
        json(200, { change: { ...CHANGE, apply: "now" }, draft: { status: "running" }, stopped_run: null }),
    });
    renderSheet();
    await sendWith(/Apply now and start iteration 2/, /Redraft the plan/);
    await screen.findByRole("button", { name: /Approve & start iteration 2/ });
    expect((calls[0].body as { apply: string }).apply).toBe("now");
    expect(screen.queryByText(/was stopped/)).toBeNull();
  });
});

describe("ChangeRequestSheet — mutation safety", () => {
  it("double click Send → exactly one request; pending label; failure shows error and re-enables", async () => {
    const gate = deferred<Response>();
    const { calls } = server({ "POST /changes": () => gate.promise });
    const onClose = renderSheet();
    const send = screen.getByRole("button", { name: /Redraft the plan/ });
    fireEvent.click(send);
    fireEvent.click(send);
    await screen.findByText("Sending…");
    expect(writes(calls)).toHaveLength(1);
    const pending = screen.getByRole("button", { name: /Sending…/ }) as HTMLButtonElement;
    expect(pending.disabled).toBe(true);
    // Closing is blocked while busy.
    expect((screen.getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => gate.resolve(json(422, { detail: "describe what is changing" })));
    expect((await screen.findByRole("alert")).textContent).toContain("describe what is changing");
    expect((screen.getByRole("button", { name: /Redraft the plan/ }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("double click Approve → one request; pending then the started run", async () => {
    const gate = deferred<Response>();
    const { calls } = server({
      "POST /changes/d_9/approve": () => gate.promise,
    });
    renderSheet();
    await reachDiff();
    const approve = screen.getByRole("button", { name: /Approve & start iteration 2/ });
    fireEvent.click(approve);
    fireEvent.click(approve);
    await screen.findByText("Starting…");
    const approveCalls = calls.filter((c) => c.url.endsWith("/approve"));
    expect(approveCalls).toHaveLength(1);
    expect(approveCalls[0].body).toEqual({ rev: 2, supersedes: ["d_1"] });
    expect((screen.getByRole("button", { name: /Starting…/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /Save without running/ }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () =>
      gate.resolve(json(200, { change: CHANGE, rev: 2, active: true, run: { run_no: 2 }, superseded: ["d_1"] })),
    );
    await screen.findByText(/Plan rev 2 is active/);
    expect(screen.getByRole("link", { name: "open run 2" }).getAttribute("href")).toBe("/projects/mou-set/runs/2");
    // The approve button is gone: there is nothing to submit twice.
    expect(screen.queryByRole("button", { name: /Approve & start/ })).toBeNull();
    expect(router.refresh).toHaveBeenCalled();
  });

  it("409 on approve shows the backend's sentence; Retry re-sends the same key", async () => {
    let n = 0;
    const { calls } = server({
      "POST /changes/d_9/approve": () =>
        ++n === 1
          ? json(409, { detail: "Run 1 is still open. Let it finish or stop it, then start the next iteration." })
          : json(200, { change: CHANGE, rev: 2, active: true, run: { run_no: 2 }, superseded: [] }),
    });
    renderSheet();
    await reachDiff();
    fireEvent.click(screen.getByRole("button", { name: /Approve & start iteration 2/ }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Run 1 is still open");
    expect((screen.getByRole("button", { name: /Approve & start iteration 2/ }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Retry approving" }));
    await screen.findByText(/Plan rev 2 is active/);
    const approveCalls = calls.filter((c) => c.url.endsWith("/approve"));
    expect(approveCalls).toHaveLength(2);
    expect(approveCalls[1].key).toBe(approveCalls[0].key);
  });

  it("Save without running activates without starting a run", async () => {
    const { calls } = server();
    renderSheet();
    await reachDiff();
    fireEvent.click(screen.getByRole("button", { name: /Save without running/ }));
    await screen.findByText(/Saved without running/);
    const approveCalls = calls.filter((c) => c.url.endsWith("/approve"));
    expect(approveCalls).toHaveLength(1);
    expect(approveCalls[0].body).toEqual({ rev: 2, start: false, supersedes: ["d_1"] });
    expect(calls.some((c) => c.url.endsWith("/runs"))).toBe(false);
    expect(screen.queryByRole("link", { name: /open run/ })).toBeNull();
  });

  it("a failed draft offers Try again, which re-drafts and polls to the diff", async () => {
    const { calls } = server({}, [{ status: "failed", detail: "No model is configured." }]);
    renderSheet();
    await sendWith(/Queue for the next iteration/, /Redraft the plan/);
    expect((await screen.findByRole("alert")).textContent).toContain("No model is configured.");
    // Point the poller at a successful draft before retrying.
    server({}, [{ status: "running" }, { status: "done", rev: 2, reading: READING }]);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("button", { name: /Approve & start iteration 2/ });
    expect(calls.some((c) => c.url.endsWith("/changes"))).toBe(true);
  });

  it("Edit plan goes to the Plan tab and closes", async () => {
    server();
    const onClose = renderSheet();
    await reachDiff();
    fireEvent.click(screen.getByRole("button", { name: "Edit plan" }));
    expect(router.push).toHaveBeenCalledWith("/projects/mou-set?tab=plan");
    expect(onClose).toHaveBeenCalled();
  });

  it("does not send an empty change", () => {
    const { calls } = server();
    render(
      <ChangeRequestSheet project={project()} playbook={playbook()} directives={null} onClose={() => {}} />,
    );
    const send = screen.getByRole("button", { name: /Redraft the plan/ }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(send);
    expect(calls).toHaveLength(0);
  });

  it("waits for the refreshed page before unlocking", async () => {
    server();
    renderSheet();
    await sendWith(/Just record it/, /Save requirement/);
    await waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(1));
  });
});
