// @vitest-environment jsdom
/**
 * A card blocked on a worker's approval shows, on its own page, what the
 * worker wants to do and lets the person answer it there.
 */
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
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

function blocked(over: Partial<ProjectCardDetail> = {}): ProjectCardDetail {
  return {
    id: "t_8736335e",
    title: "Export the PDF and deliver the Canva link",
    body: null,
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
    latest_summary: "Approval needed: mcp_canva_export_design — to export the deck.",
    comments: [],
    ...over,
  } as ProjectCardDetail;
}

const EXPORT = {
  key: "mcp_canva_export_design",
  label: "mcp_canva_export_design",
  detail:
    'mcp_canva_export_design\n{"design_id": "DAHXSa-9nsc", "format": {"type": "pdf"}, "user_intent": "Export the final deck for submission"}',
  requested_at: 1,
};
const SCRIPT = {
  key: "script execution via -e/-c flag",
  label: "script execution via -e/-c flag",
  detail: "python3 -c \"print('py ok')\"",
  requested_at: 2,
};

describe("CardDetailView approvals", () => {
  it("shows every pending approval with what it wants to do, and no Make ready", () => {
    const view = render(
      <CardDetailView slug="tender" card={blocked({ pending_approvals: [EXPORT, SCRIPT] })} />,
    );
    const rows = view.container.querySelectorAll('[data-component="CardApproval"]');
    expect([...rows].map((r) => r.getAttribute("data-approval-key"))).toEqual([EXPORT.key, SCRIPT.key]);
    const exportRow = rows[0] as HTMLElement;
    expect(within(exportRow).getByText("Waiting on you: allow mcp_canva_export_design?")).toBeTruthy();
    expect(within(exportRow).getByText("Export the final deck for submission")).toBeTruthy();
    expect(within(exportRow).getByText("DAHXSa-9nsc")).toBeTruthy();
    expect(
      within(exportRow).getByText(/Open the design in Canva/).closest("a")?.getAttribute("href"),
    ).toBe("https://www.canva.com/design/DAHXSa-9nsc/view");
    expect(within(rows[1] as HTMLElement).getByText("python3 -c \"print('py ok')\"")).toBeTruthy();
    expect(view.queryByText("Make ready")).toBeNull();
    expect(view.queryByText("Answer the agent")).toBeNull();
    expect(view.queryByText("Re-run card")).toBeNull();
  });

  it("Allow answers that approval for this card, once", async () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<CardDetailView slug="tender" card={blocked({ pending_approvals: [EXPORT] })} />);
    const allow = view.getByText("Allow on this card");
    await act(async () => {
      fireEvent.click(allow);
      fireEvent.click(allow);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/projects/tender/cards/t_8736335e/approvals");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ key: EXPORT.key, decision: "approve" });
  });

  it("an archived project shows the request but no buttons", () => {
    const view = render(
      <CardDetailView slug="tender" archived card={blocked({ pending_approvals: [EXPORT] })} />,
    );
    expect(view.getByText("Waiting on you: allow mcp_canva_export_design?")).toBeTruthy();
    expect(view.queryByText("Allow on this card")).toBeNull();
    expect(view.queryByText("Deny")).toBeNull();
  });

  it("a card blocked for anything else offers Re-run card", () => {
    const view = render(<CardDetailView slug="tender" card={blocked({ pending_approvals: [] })} />);
    expect(view.container.querySelector('[data-component="CardApproval"]')).toBeNull();
    expect(view.getByText("Re-run card")).toBeTruthy();
  });
});
