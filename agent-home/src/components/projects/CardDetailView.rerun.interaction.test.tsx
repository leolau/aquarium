// @vitest-environment jsdom
/**
 * A blocked card (not waiting on an approval) is sent back to the agent
 * from its own page: an optional answer lands on the card's thread via
 * the unblock route, and Save & re-run saves an edited brief first — never
 * unblocking when the save was refused.
 */
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => router,
}));

import { CardDetailView } from "@/components/projects/CardDetailView";
import type { ProjectCardDetail } from "@/types";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  router.refresh.mockReset();
});

function card(over: Partial<ProjectCardDetail> = {}): ProjectCardDetail {
  return {
    id: "t_42",
    title: "Collect the tender documents",
    body: "Download the tender pack.",
    status: "blocked",
    assignee: "default",
    priority: 0,
    created_at: 1,
    started_at: null,
    completed_at: null,
    tenant: null,
    project_id: "prj_1",
    result: null,
    current_step_key: null,
    block_kind: "needs_input",
    latest_summary: "Where is the tender pack? I need a Drive link.",
    comments: [],
    ...over,
  } as ProjectCardDetail;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function calls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.map((c) => {
    const [url, init] = c as [string, RequestInit];
    return {
      url,
      method: init.method,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
  });
}

const UNBLOCK = "/api/projects/tender/cards/t_42/unblock";
const CARD_URL = "/api/projects/tender/cards/t_42";

describe("CardDetailView — re-run a blocked card", () => {
  it("offers an answer box with Re-run card in place of Make ready", () => {
    const view = render(<CardDetailView slug="tender" card={card()} />);
    expect(view.getByLabelText("Answer the agent")).toBeTruthy();
    expect(view.getByText("Re-run card")).toBeTruthy();
    expect(
      view.getByText("The agent starts this card again using the current brief and your answer."),
    ).toBeTruthy();
    expect(view.queryByText("Make ready")).toBeNull();
  });

  it("Re-run with my answer posts the answer to unblock and the badge leaves blocked", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { ...card(), status: "ready" }));
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<CardDetailView slug="tender" card={card()} />);

    fireEvent.change(view.getByLabelText("Answer the agent"), {
      target: { value: "  https://drive.google.com/drive/folders/abc  " },
    });
    const button = view.getByText("Re-run with my answer");
    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button);
    });

    expect(calls(fetchMock)).toEqual([
      {
        url: UNBLOCK,
        method: "POST",
        body: { reason: "https://drive.google.com/drive/folders/abc" },
      },
    ]);
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(view.getByText("ready")).toBeTruthy();
    expect(view.queryByText("blocked")).toBeNull();
    expect(view.container.querySelector('[data-component="CardBlockedReason"]')).toBeNull();
    expect(view.queryByLabelText("Answer the agent")).toBeNull();
  });

  it("an empty answer still re-runs, without a reason", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { ...card(), status: "ready" }));
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<CardDetailView slug="tender" card={card()} />);
    await act(async () => {
      fireEvent.click(view.getByText("Re-run card"));
    });
    expect(calls(fetchMock)).toEqual([{ url: UNBLOCK, method: "POST", body: {} }]);
  });

  it("a refused re-run keeps the card blocked and says why", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(409, { detail: "the card is not blocked" })));
    const view = render(<CardDetailView slug="tender" card={card()} />);
    fireEvent.change(view.getByLabelText("Answer the agent"), { target: { value: "here" } });
    fireEvent.click(view.getByText("Re-run with my answer"));
    expect((await view.findByRole("alert")).textContent).toContain("not blocked");
    expect(view.getByText("blocked")).toBeTruthy();
    expect((view.getByLabelText("Answer the agent") as HTMLTextAreaElement).value).toBe("here");
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("Save & re-run saves the edited brief, then unblocks", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(200, { ...card(), body: "Use the Drive folder." }))
      .mockResolvedValueOnce(json(200, { ...card(), body: "Use the Drive folder.", status: "ready" }));
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<CardDetailView slug="tender" card={card()} />);

    fireEvent.click(view.getByText("Edit card"));
    fireEvent.change(view.getByLabelText("Brief"), { target: { value: "Use the Drive folder." } });
    await act(async () => {
      fireEvent.click(view.getByText("Save & re-run"));
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(calls(fetchMock)).toEqual([
      { url: CARD_URL, method: "PATCH", body: { body: "Use the Drive folder." } },
      { url: UNBLOCK, method: "POST", body: {} },
    ]);
    await waitFor(() => expect(view.getByText("ready")).toBeTruthy());
    expect(view.queryByText("Save & re-run")).toBeNull();
  });

  it("Save & re-run does not unblock when the save fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(422, { detail: "the brief is too long" }));
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<CardDetailView slug="tender" card={card()} />);

    fireEvent.click(view.getByText("Edit card"));
    fireEvent.change(view.getByLabelText("Brief"), { target: { value: "x".repeat(10) } });
    fireEvent.click(view.getByText("Save & re-run"));

    expect((await view.findByText(/too long/)).textContent).toContain("too long");
    expect(calls(fetchMock).map((c) => c.url)).toEqual([CARD_URL]);
    expect(view.getByText("blocked")).toBeTruthy();
    expect(view.getByText("Save & re-run")).toBeTruthy();
  });

  it("Save & re-run with nothing changed just unblocks", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { ...card(), status: "ready" }));
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<CardDetailView slug="tender" card={card()} />);
    fireEvent.click(view.getByText("Edit card"));
    await act(async () => {
      fireEvent.click(view.getByText("Save & re-run"));
    });
    expect(calls(fetchMock)).toEqual([{ url: UNBLOCK, method: "POST", body: {} }]);
  });

  it("Save & re-run sends the answer typed above along with the re-run", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(200, card()))
      .mockResolvedValueOnce(json(200, { ...card(), status: "ready" }));
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<CardDetailView slug="tender" card={card()} />);
    fireEvent.change(view.getByLabelText("Answer the agent"), { target: { value: "see Drive" } });
    fireEvent.click(view.getByText("Edit card"));
    fireEvent.change(view.getByLabelText("Title"), { target: { value: "Collect the pack" } });
    await act(async () => {
      fireEvent.click(view.getByText("Save & re-run"));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(calls(fetchMock)[1]).toEqual({ url: UNBLOCK, method: "POST", body: { reason: "see Drive" } });
  });

  it("only a blocked card without pending approvals offers Save & re-run", () => {
    const approval = {
      key: "mcp_canva_export_design",
      label: "mcp_canva_export_design",
      detail: "mcp_canva_export_design",
      requested_at: 1,
    };
    for (const c of [
      card({ status: "todo", block_kind: null }),
      card({ status: "running", block_kind: null }),
      card({ pending_approvals: [approval] }),
    ]) {
      const view = render(<CardDetailView slug="tender" card={c} />);
      fireEvent.click(view.getByText("Edit card"));
      expect(view.getByText("Save")).toBeTruthy();
      expect(view.queryByText("Save & re-run")).toBeNull();
      expect(view.queryByLabelText("Answer the agent")).toBeNull();
      cleanup();
    }
  });

  it("an archived project's blocked card shows no answer box or actions", () => {
    const view = render(<CardDetailView slug="tender" archived card={card()} />);
    expect(view.container.querySelector('[data-component="CardBlockedReason"]')).toBeTruthy();
    expect(view.queryByLabelText("Answer the agent")).toBeNull();
    expect(view.queryByText("Re-run card")).toBeNull();
    expect(view.queryByText("Edit card")).toBeNull();
  });
});
