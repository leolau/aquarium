import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/mou-set/runs/3",
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

import { project } from "@/components/projects/changes/testFixtures";
import { tabProps } from "@/components/projects/iterations/testFixtures";
import { IterationsTab } from "@/components/projects/tabs/IterationsTab";

describe("IterationsTab markup", () => {
  it("groups runs into iterations newest first, current expanded", () => {
    const html = renderToStaticMarkup(<IterationsTab {...tabProps()} />);
    const order = [...html.matchAll(/data-iteration="(\d+)"/g)].map((m) => m[1]);
    expect(order).toEqual(["2", "1"]);
    expect(html).toMatch(/data-iteration="2"[^>]*open=""/);
    expect(html).not.toMatch(/data-iteration="1"[^>]*open=""/);
    expect(html).toContain("plan rev 2");
    expect(html).toContain('href="/projects/mou-set/runs/3"');
    expect(html).toContain("+ Add a Chinese edition");
    expect(html).toContain("Start a new iteration with changes");
  });

  it("lists the requirement history with where each first applied", () => {
    const html = renderToStaticMarkup(<IterationsTab {...tabProps()} />);
    expect(html).toContain("Requirement history");
    expect(html).toMatch(/Add a Chinese edition[\s\S]*from iteration 2/);
    expect(html).toMatch(/Keep it under 500 words[\s\S]*from iteration 1/);
  });

  it("keeps All runs and Standing instructions reachable", () => {
    const html = renderToStaticMarkup(<IterationsTab {...tabProps()} />);
    expect(html).toContain("All runs");
    expect(html).toContain("Standing instructions");
    expect(html).toContain('data-component="IterationsTab"');
  });

  it("with no runs shows iteration 1 ready to start", () => {
    const html = renderToStaticMarkup(
      <IterationsTab {...tabProps({ project: project({ runs: [] }), directives: null })} />,
    );
    expect(html).toContain("Iteration 1");
    expect(html).toContain("ready to start");
    expect(html).toContain("No requirement changes yet");
  });

  it("hides the change button on an archived project", () => {
    const html = renderToStaticMarkup(
      <IterationsTab {...tabProps({ project: project({ archived: true }) })} />,
    );
    expect(html).not.toContain("Start a new iteration with changes");
  });
});
