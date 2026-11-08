import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects",
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

import { ChangeRequestSheet, readingLine } from "@/components/projects/changes/ChangeRequestSheet";
import { PlanDiffView } from "@/components/projects/changes/PlanDiffView";
import { planDiff } from "@/components/projects/changes/planDiff";
import { project, playbook, run } from "@/components/projects/changes/testFixtures";

describe("ChangeRequestSheet markup", () => {
  it("renders the three steps with the text pre-filled", () => {
    const html = renderToStaticMarkup(
      <ChangeRequestSheet
        project={project({ runs: [run(1, { status: "running", ended_at: null })] })}
        playbook={playbook()}
        directives={null}
        initialText="Add a Chinese edition"
        onClose={() => {}}
      />,
    );
    expect(html).toContain("Change requirements");
    expect(html).toContain("1 · What’s changing");
    expect(html).toContain("2 · When should this apply?");
    expect(html).toContain("Add a Chinese edition</textarea>");
    for (const chip of ["Add requirement", "Change direction", "Change an output", "Attach", "Memory"]) {
      expect(html).toContain(chip);
    }
    expect(html).toContain("Pause run 1 and apply now");
    expect(html).toContain("recommended");
    expect(html).toContain("finished work is kept");
    expect(html).toContain("Queue for the next iteration");
    expect(html).toContain("Ready to start iteration 2");
    expect(html).toContain("Just record it");
    expect(html).toContain("step 2 of 3");
    // Step 3 only appears once the change is sent.
    expect(html).not.toContain("Agent’s updated plan");
  });

  it("offers 'Apply now and start iteration N+1' when no run is open", () => {
    const html = renderToStaticMarkup(
      <ChangeRequestSheet project={project({ runs: [run(1)] })} playbook={playbook()} directives={null} onClose={() => {}} />,
    );
    expect(html).toContain("Apply now and start iteration 2");
    expect(html).not.toContain("Pause run");
    expect(html).toContain("step 1 of 3");
  });

  it("refuses to send on an archived project", () => {
    const html = renderToStaticMarkup(
      <ChangeRequestSheet project={project({ archived: true })} playbook={playbook()} directives={null} initialText="x" onClose={() => {}} />,
    );
    expect(html).toContain("archived");
  });
});

describe("readingLine", () => {
  it("summarises changes, affected outputs and superseded requirements", () => {
    expect(
      readingLine({
        changes: ["term + law", "revenue split"],
        affected_outputs: [{ id: "o1", title: "4 MOUs" }],
        supersedes: [{ id: "d1", body: "Split 2.5%" }],
      }),
    ).toBe("2 requirement changes (term + law; revenue split) · affects output “4 MOUs” · supersedes “Split 2.5%”");
    expect(readingLine({ changes: ["x"], affected_outputs: [], supersedes: [] })).toBe("1 requirement change (x)");
  });
});

describe("PlanDiffView", () => {
  it("marks removed rows struck through and added rows green", () => {
    const html = renderToStaticMarkup(
      <PlanDiffView diff={planDiff([{ key: "a", title: "Old" }], [{ key: "b", title: "New" }])} />,
    );
    expect(html).toMatch(/data-diff="removed"[^>]*line-through/);
    expect(html).toMatch(/data-diff="added"[^>]*emerald/);
    expect(html).toContain("1 added · 1 removed");
  });

  it("says when the plan stays the same", () => {
    const html = renderToStaticMarkup(<PlanDiffView diff={planDiff([{ key: "a", title: "A" }], [{ key: "a", title: "A" }])} />);
    expect(html).toContain("The plan stays the same.");
  });
});
