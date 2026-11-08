// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects",
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

import { T0, project, run } from "@/components/projects/changes/testFixtures";
import { tabProps } from "@/components/projects/iterations/testFixtures";
import { IterationsTab } from "@/components/projects/tabs/IterationsTab";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("IterationsTab", () => {
  it("reads GET /changes for retired requirements and change kinds", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          changes: [
            {
              id: "d_old", project_id: "prj_1", kind: "directive", body: "English only",
              scope: "project", target_ref: null, rating: null, author_user_id: "ada",
              created_at: T0, active: 0, retired_at: T0 + 2 * 3600, superseded_by: "d_new",
              kinds: [], apply: null, is_change: false,
            },
            {
              id: "d_new", project_id: "prj_1", kind: "directive", body: "Bilingual issues",
              scope: "project", target_ref: null, rating: null, author_user_id: "leo",
              created_at: T0 + 2 * 3600, active: 1, retired_at: null, superseded_by: null,
              kinds: ["direction"], apply: "now", is_change: true,
            },
          ],
          runs: [
            { ...run(1), id: "r1", playbook_rev: 1, deliveries: 0, cards_done: 1, cards_total: 2 },
            { ...run(2, { status: "running", ended_at: null }), id: "r2", playbook_rev: 1, deliveries: 0, cards_done: 0, cards_total: 2 },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<IterationsTab {...tabProps({ project: project({ runs: [] }), directives: null })} />);
    await screen.findByText("English only");
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/mou-set/changes", { cache: "no-store" });
    const retired = document.querySelector('[data-requirement="d_old"]');
    expect(retired?.getAttribute("data-status")).toBe("retired");
    expect(retired?.textContent).toContain("superseded");
    const added = document.querySelector('[data-requirement="d_new"]');
    expect(added?.textContent).toContain("Change direction");
    expect(added?.textContent).toContain("from iteration 2");
    expect(screen.getByText(/1\/2 steps/)).toBeTruthy();
  });

  it("falls back to the page's data when the history cannot be read", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<IterationsTab {...tabProps()} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(document.querySelectorAll("[data-iteration]")).toHaveLength(2);
  });

  it("opens the change flow", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    const onChangeRequest = vi.fn();
    render(<IterationsTab {...tabProps({ onChangeRequest })} />);
    fireEvent.click(screen.getByRole("button", { name: "Start a new iteration with changes" }));
    expect(onChangeRequest).toHaveBeenCalledWith();
  });
});
