// @vitest-environment jsdom
/**
 * "Draft with the agent" in the Plan panel is a project-scoped, server-side
 * job: the button POSTs, the panel polls the same route, and the outcome is
 * reported in place — the user is never sent to chat, and the proposal only
 * ever lands as an inactive revision the lead activates.
 */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => router,
}));

import { PlanPanel } from "@/components/projects/panels/PlanPanel";
import type { ProjectPlaybookDraftState } from "@/types";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const PROPS = {
  slug: "monday-digest",
  playbook: { active: null, revisions: [] },
  profiles: ["default"],
  canActivate: true,
  archived: false,
};

const DRAFT_URL = "/api/projects/monday-digest/playbook/draft";

/** Answer GETs from a queue of states; POST starts the job. */
function draftServer(states: ProjectPlaybookDraftState[]) {
  const queue = [...states];
  return vi.fn((url: string, init?: RequestInit) => {
    if (url !== DRAFT_URL) return Promise.resolve(jsonResponse(404, {}));
    if (init?.method === "POST") {
      return Promise.resolve(jsonResponse(200, { status: "running" }));
    }
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    return Promise.resolve(jsonResponse(200, next));
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  router.push.mockReset();
  router.refresh.mockReset();
});

describe("PlanPanel — Draft with the agent", () => {
  it("starts the server-side job, shows progress, then reports the proposal", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = draftServer([
      { status: "idle" },
      { status: "running", started_at: 1 },
      { status: "done", rev: 2 },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const { getByText, findByText, queryByText } = render(<PlanPanel {...PROPS} />);
    fireEvent.click(getByText("Draft with the agent"));

    await findByText("Agent is drafting…");
    expect(queryByText(/reading the brief/)).toBeTruthy();
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(post?.[0]).toBe(DRAFT_URL);

    await vi.advanceTimersByTimeAsync(2_100);
    await findByText(/proposed revision 2/);
    expect(router.refresh).toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
    expect(queryByText("Agent is drafting…")).toBeNull();
  });

  it("explains a failed draft in place and re-enables the button", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = draftServer([
      { status: "idle" },
      { status: "failed", detail: "the agent did not return a plan" },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const { getByText, findByRole } = render(<PlanPanel {...PROPS} />);
    fireEvent.click(getByText("Draft with the agent"));

    await vi.advanceTimersByTimeAsync(2_100);
    const alert = await findByRole("alert");
    expect(alert.textContent).toMatch(/could not draft|did not return/);
    expect((getByText("Draft with the agent") as HTMLButtonElement).disabled).toBe(false);
  });

  it("resumes waiting on a draft that was running before the page loaded", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = draftServer([{ status: "running", started_at: 1 }]);
    vi.stubGlobal("fetch", fetchMock);

    const { findByText } = render(<PlanPanel {...PROPS} />);
    await findByText("Agent is drafting…");
    expect(fetchMock.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
  });

  it("refuses a second draft while one is running, without leaving the page", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return Promise.resolve(
          jsonResponse(409, { detail: "a draft is already running for this project" }),
        );
      }
      return Promise.resolve(jsonResponse(200, { status: "idle" }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const { getByText, findByRole } = render(<PlanPanel {...PROPS} />);
    fireEvent.click(getByText("Draft with the agent"));
    const alert = await findByRole("alert");
    expect(alert.textContent).toBeTruthy();
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe("PlanPanel — a proposed revision is the pending decision", () => {
  const PROPOSED = {
    active: null,
    revisions: [
      {
        project_id: "prj_1",
        rev: 2,
        body: "Draft, review, send.",
        steps: [{ key: "draft", title: "Draft it" }],
        active: 0,
        created_by: "leo",
        created_at: 1,
        activated_at: null,
        note: null,
      },
    ],
  };

  it("locks Draft/Write while a proposal waits, offering Activate and Discard", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(200, { status: "idle" }))),
    );
    const { getByText, container } = render(
      <PlanPanel {...PROPS} playbook={PROPOSED} />,
    );
    expect(
      (getByText("Draft with the agent") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((getByText("Write plan") as HTMLButtonElement).disabled).toBe(true);
    expect(getByText("Activate")).toBeTruthy();
    const discard = container.querySelector('[data-action="discard-revision"]');
    expect(discard).toBeTruthy();
    expect((discard as HTMLButtonElement).disabled).toBe(false);
  });

  it("Discard DELETEs the revision, then Draft/Write unlock on refresh", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        return Promise.resolve(jsonResponse(200, { rev: 2, discarded: true }));
      }
      return Promise.resolve(jsonResponse(200, { status: "idle" }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container, rerender, getByText } = render(
      <PlanPanel {...PROPS} playbook={PROPOSED} />,
    );
    const discard = container.querySelector(
      '[data-action="discard-revision"]',
    ) as HTMLButtonElement;
    fireEvent.click(discard);

    await vi.waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([, init]) => init?.method === "DELETE",
      );
      expect(call?.[0]).toBe("/api/projects/monday-digest/playbook/2");
    });
    await vi.waitFor(() => expect(router.refresh).toHaveBeenCalled());
    const del = fetchMock.mock.calls.find(
      ([, init]) => init?.method === "DELETE",
    );
    expect(
      (del?.[1]?.headers as Record<string, string>)["Idempotency-Key"],
    ).toBeTruthy();

    // The refreshed tree reports the proposal gone — the doors reopen.
    rerender(<PlanPanel {...PROPS} playbook={{ active: null, revisions: [] }} />);
    expect(
      (getByText("Draft with the agent") as HTMLButtonElement).disabled,
    ).toBe(false);
    expect((getByText("Write plan") as HTMLButtonElement).disabled).toBe(false);
  });

  it("a refused discard surfaces the reason in place and keeps the proposal", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        return Promise.resolve(
          jsonResponse(409, { detail: "the active revision cannot be discarded" }),
        );
      }
      return Promise.resolve(jsonResponse(200, { status: "idle" }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container, findByRole, getByText } = render(
      <PlanPanel {...PROPS} playbook={PROPOSED} />,
    );
    fireEvent.click(
      container.querySelector('[data-action="discard-revision"]')!,
    );
    const alert = await findByRole("alert");
    expect(alert.textContent).toMatch(/cannot be discarded/);
    // Nothing was lost — the decision row is still there.
    expect(getByText("Activate")).toBeTruthy();
    expect(router.refresh).not.toHaveBeenCalled();
  });
});

describe("PlanPanel — a superseded revision is history, not a pending decision", () => {
  const REV = (rev: number, active: 0 | 1, body: string) => ({
    project_id: "prj_1",
    rev,
    body,
    steps: [{ key: `s${rev}`, title: `Step of rev ${rev}` }],
    active,
    created_by: "leo",
    created_at: rev,
    activated_at: active ? 10 : null,
    note: "drafted by the agent",
  });

  it("keeps an older inactive revision out of the proposals and leaves Draft/Revise open", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(200, { status: "idle" }))),
    );
    const { container, getByText, queryByText } = render(
      <PlanPanel
        {...PROPS}
        playbook={{ active: REV(2, 1, "Second plan."), revisions: [REV(2, 1, "Second plan."), REV(1, 0, "First plan.")] }}
      />,
    );
    expect(container.querySelector('[data-component="ProposedRevisions"]')).toBeNull();
    expect(queryByText(/awaiting a decision/)).toBeNull();
    const earlier = container.querySelector('[data-component="EarlierRevisions"]');
    expect(earlier?.textContent).toContain("Earlier revisions (1)");
    expect(earlier?.textContent).toContain("First plan.");
    expect(getByText("Switch back to this")).toBeTruthy();
    expect((getByText("Draft with the agent") as HTMLButtonElement).disabled).toBe(false);
    expect((getByText("Revise") as HTMLButtonElement).disabled).toBe(false);
  });

  it("confirms the activation once the refreshed plan shows the new revision active", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url.endsWith("/playbook/3/activate")) {
        return Promise.resolve(jsonResponse(200, { rev: 3, active: true, by: "leo" }));
      }
      return Promise.resolve(jsonResponse(200, { status: "idle" }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const before = {
      active: REV(2, 1, "Second plan."),
      revisions: [REV(3, 0, "Third plan."), REV(2, 1, "Second plan.")],
    };
    const { container, getByText, findByText, rerender } = render(
      <PlanPanel {...PROPS} playbook={before} />,
    );
    expect(container.querySelector('[data-component="ProposedRevisions"]')).toBeTruthy();
    fireEvent.click(getByText("Activate"));
    await vi.waitFor(() => expect(router.refresh).toHaveBeenCalled());

    rerender(
      <PlanPanel
        {...PROPS}
        playbook={{
          active: REV(3, 1, "Third plan."),
          revisions: [REV(3, 1, "Third plan."), REV(2, 0, "Second plan.")],
        }}
      />,
    );
    await findByText(/Revision 3 is now the active plan/);
    expect(container.querySelector('[data-component="ProposedRevisions"]')).toBeNull();
    expect(container.querySelector('[data-component="EarlierRevisions"]')?.textContent).toContain(
      "Second plan.",
    );
  });
});
