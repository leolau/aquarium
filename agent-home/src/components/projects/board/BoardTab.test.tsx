import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects",
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

import { BoardView } from "@/components/projects/board/BoardView";
import { BOARD, CONTEXT, PROJECT } from "@/components/projects/board/fixtures";
import { BoardTab } from "@/components/projects/tabs/BoardTab";
import type { ProjectTabProps } from "@/components/projects/tabs/types";

const TAB_PROPS = {
  project: PROJECT,
  board: BOARD,
  playbook: null,
  directives: null,
  doctor: null,
  callerUserId: "leo",
  canLead: true,
  readiness: [],
  runnable: true,
  onNavigate: () => {},
  onChangeRequest: () => {},
} as unknown as ProjectTabProps;

describe("BoardTab (SSR)", () => {
  it("renders the strip, the four lanes and the stage toggle", () => {
    const html = renderToStaticMarkup(<BoardTab {...TAB_PROPS} />);
    expect(html).toContain('data-component="BoardTab"');
    expect(html).toContain('data-component="NeedsYouStrip"');
    expect(html).toContain("The agent can’t continue until a person acts");
    expect(html).toContain("Approve all 3");
    for (const lane of ["Up next", "Working", "Waiting", "Done"]) expect(html).toContain(lane);
    expect(html).toContain("Show all 8 stages");
    expect(html).toContain("＋ New card");
    expect(html).toContain("Needs me · 5");
    expect(html).toContain("+2 more");
    expect(html).not.toContain("Move to…");
    // Verbs instead of a dropdown.
    expect(html).toContain(">Approve<");
    expect(html).toContain(">Unblock<");
    expect(html).toContain(">Review<");
    expect(html).toContain("Assign ▾");
  });

  it("tiles carry status, who, age and comments; live without presence", () => {
    const html = renderToStaticMarkup(<BoardTab {...TAB_PROPS} />);
    expect(html).toContain('data-avatar="agent"');
    expect(html).toContain('data-avatar="none"');
    expect(html).toContain("waiting for a worker");
    expect(html).toContain("💬 2");
    expect(html).toContain("· 2d");
    expect(html).toMatch(/●<\/span> live<\/span>/);
  });

  it("degrades when the board read failed", () => {
    const html = renderToStaticMarkup(<BoardTab {...TAB_PROPS} board={null} />);
    expect(html).toContain("unavailable");
  });
});

describe("BoardView (SSR) with run context and presence", () => {
  it("names the run that made each card, the stalled run, and who else is viewing", () => {
    const html = renderToStaticMarkup(
      <BoardView
        project={PROJECT}
        board={{ ...BOARD, columns: BOARD.columns.map((c) => (c.name === "ready" ? { ...c, tasks: [] } : c)) }}
        callerUserId="leo"
        canLead
        context={CONTEXT}
        viewers={["leo", "Yan"]}
      />,
    );
    expect(html).toContain("created by run 2");
    expect(html).toContain("Nothing running. Run 2 is stalled — <a");
    expect(html).toContain(">see why</a>.");
    expect(html).toContain("live · Yan is viewing");
    expect(html).toContain('aria-label="Filter by run"');
    expect(html).toContain(">Run 1<");
  });
});
