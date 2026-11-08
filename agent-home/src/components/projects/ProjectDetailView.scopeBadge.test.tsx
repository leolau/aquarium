import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects",
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock("@/components/projects/outputs/LatestOutputsShelf", () => ({ LatestOutputsShelf: () => null }));

import { ProjectDetailView } from "@/components/projects/ProjectDetailView";
import { board, playbook, project } from "@/components/projects/dashboard/__fixtures__/dashboard";
import type { ClarifySummary, ProjectDetail } from "@/types";

function scopeTab(p: ProjectDetail): string {
  const html = renderToStaticMarkup(
    <ProjectDetailView
      project={p}
      board={board()}
      playbook={playbook()}
      directives={null}
      callerUserId="yan"
      isInstanceAdmin={false}
    />,
  );
  const match = html.match(/<button[^>]*data-tab="setup"[^>]*>([\s\S]*?)<\/button>/);
  expect(match).not.toBeNull();
  return match![1];
}

const summary = (over: Partial<ClarifySummary>): ClarifySummary => ({
  status: "open",
  round: 1,
  open_count: 0,
  answered_count: 0,
  understanding: null,
  confirmed_at: null,
  ...over,
});

describe("ProjectDetailView — Setup tab badge (open scope questions)", () => {
  it("shows how many scope questions are open", () => {
    const tab = scopeTab(project({ clarify: summary({ open_count: 3 }) }));
    expect(tab).toMatch(/^Setup<span[^>]*>3<\/span>$/);
  });

  it("shows no badge with nothing open, or on an older server without clarify", () => {
    expect(scopeTab(project({ clarify: summary({ status: "answered", open_count: 0 }) }))).toBe("Setup");
    expect(scopeTab(project())).toBe("Setup");
    expect(scopeTab(project({ clarify: null }))).toBe("Setup");
  });
});
