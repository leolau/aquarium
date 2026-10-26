/** SSR markup for the Outputs tab: deliverables with versions, drafts and
 * notes with provenance, the unattached warning, and decoded specs. */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

import { ARTIFACT, DELIVERY, NOW, OUTPUT, PROJECT, TAB_PROPS } from "@/components/projects/outputs/fixtures";
import { OutputsPanel } from "@/components/projects/panels/OutputsPanel";
import { OutputsTab } from "@/components/projects/tabs/OutputsTab";

const DELIVERED = OUTPUT({
  id: "out_1",
  title: "2 MOUs in docx",
  spec: "\\u9752\\u7530\\u8207\\u5408\\u4f5c\\u65b9",
  status: "delivered",
  deliveries: [
    DELIVERY({ id: "d1", run_id: "run_a", delivered_at: NOW - 900, label: "MOU v1.docx" }),
    DELIVERY({ id: "d2", run_id: "run_c", delivered_at: NOW - 100, label: "MOU v2.docx" }),
  ],
});
const PENDING = OUTPUT({ id: "out_2", seq: 2, title: "4 MOUs in docx" });

const ARTIFACTS = [
  ARTIFACT({ id: "d:d2", kind: "deliverable", output_id: "out_1", title: "MOU v2.docx", run_no: 3, version: 2 }),
  ARTIFACT({ id: "d:d1", kind: "deliverable", output_id: "out_1", title: "MOU v1.docx", run_no: 1, version: 1 }),
  ARTIFACT({ id: "f:1", title: "mou-qingtian.docx", run_no: 1 }),
  ARTIFACT({ id: "f:2", title: "mou-partner.docx", run_no: 1 }),
  ARTIFACT({ id: "f:3", title: "party-notes.md", kind: "note", ext: "md", run_no: 2, card_title: "Confirm parties" }),
];

function render(over = {}, artifacts = ARTIFACTS) {
  const project = PROJECT({ outputs: [DELIVERED, PENDING], ...over });
  return renderToStaticMarkup(
    <OutputsTab {...TAB_PROPS(project)} initialArtifacts={artifacts} />,
  );
}

describe("OutputsTab SSR", () => {
  it("shows each deliverable with its versions per run and its verbs", () => {
    const html = render();
    expect(html).toContain('data-component="Deliverables"');
    expect(html).toContain("2 MOUs in docx");
    expect(html).toContain("v2 · run 3");
    expect(html).toContain("v1 · run 1");
    expect(html.indexOf("v2 · run 3")).toBeLessThan(html.indexOf("v1 · run 1"));
    expect(html).toContain("delivered · v2");
    expect(html).toContain("Accept");
    expect(html).toContain("Request changes");
    expect(html).toContain("Mark superseded");
    expect(html).toContain('aria-label="Open MOU v2.docx"');
  });

  it("decodes escaped specs instead of showing \\u codes", () => {
    const html = render();
    expect(html).toContain("青田與合作方");
    expect(html).not.toContain("\\u9752");
  });

  it("lists drafts and working notes with the run/card they came from", () => {
    const html = render();
    expect(html).toContain('data-component="AllFiles"');
    expect(html).toContain("party-notes.md");
    expect(html).toContain("working note");
    expect(html).toContain("run 2 · Confirm parties");
    expect(html).toContain('data-kind="draft"');
    expect(html).toContain("DOCX");
  });

  it("warns about files no output owns and offers to attach them", () => {
    const html = render();
    expect(html).toContain('data-component="UnattachedWarning"');
    expect(html).toContain("Run 1 produced 2 files that aren&#x27;t linked to any output.");
    // With several candidate outputs each row shows a target picker plus a
    // plain "Add to output" button; the group also gets a one-shot Add-all.
    expect(html).toContain('data-component="AttachAll"');
    expect(html).toContain("Add all 2 to");
    expect(html).toContain("4 MOUs in docx");
  });

  it("has no warning when every draft is attached", () => {
    const html = render({}, ARTIFACTS.filter((a) => a.kind !== "draft"));
    expect(html).not.toContain('data-component="UnattachedWarning"');
  });

  it("once every output has a delivery, unlinked files are a collapsed 'other files' list", () => {
    const html = render({ outputs: [DELIVERED] });
    expect(html).not.toContain('data-component="UnattachedWarning"');
    expect(html).not.toContain("aren&#x27;t linked to any output");
    expect(html).toContain('data-component="OtherRunFiles"');
    expect(html).toContain("<details");
    expect(html).toContain("Other files from Run 1 (2)");
    expect(html).toContain("nothing here");
    expect(html).toContain("Add as a new version of “2 MOUs in docx”");
    expect(html).not.toContain('data-component="AttachAll"');
  });

  it("lists the final outputs first, badged, and working files after them", () => {
    const html = render({ outputs: [DELIVERED] });
    expect(html).toContain("Final outputs");
    expect(html).toContain('data-testid="final-output-badge"');
    expect(html).toContain("Working files (not the result)");
    expect(html.indexOf('data-component="Deliverables"')).toBeLessThan(
      html.indexOf('data-component="WorkingFiles"'),
    );
    expect(html.indexOf('data-component="WorkingFiles"')).toBeLessThan(
      html.indexOf('data-component="OtherRunFiles"'),
    );
  });

  it("the warning names the output still waiting for a delivery", () => {
    const html = render();
    expect(html).toContain("“4 MOUs in docx” has nothing delivered yet.");
  });

  it("a file cleared with its card's workspace says so instead of a dead Open", () => {
    const html = render({}, [
      ARTIFACT({ id: "f:gone", title: "quote.pdf", href: null, missing: true }),
      ARTIFACT({ id: "f:far", title: "far.md", href: null, location: "/srv" }),
    ]);
    expect(html).toContain('data-testid="file-missing"');
    expect(html).toContain("Deleted when its card finished");
    expect(html).not.toContain('aria-label="Open quote.pdf"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Open far.md"/);
  });

  it("a delivery recorded as a bare web link still opens without the files read", () => {
    const project = PROJECT({
      outputs: [
        OUTPUT({
          status: "delivered",
          deliveries: [
            DELIVERY({ id: "dg", link_kind: null, link_ref: "https://docs.google.com/document/d/abc/edit" }),
          ],
        }),
      ],
    });
    const html = renderToStaticMarkup(
      <OutputsTab {...TAB_PROPS(project)} initialArtifacts={[]} />,
    );
    expect(html).toContain('href="https://docs.google.com/document/d/abc/edit"');
  });

  it("an archived project shows files but no write verbs", () => {
    const html = render({ archived: true });
    expect(html).toContain("restore it");
    expect(html).not.toContain("Mark superseded");
    expect(html).not.toContain("Add to");
    expect(html).not.toContain('data-component="AddOutputForm"');
    expect(html).toContain("mou-qingtian.docx");
  });

  it("shows a skeleton while the files read is in flight", () => {
    const project = PROJECT({ outputs: [DELIVERED] });
    const html = renderToStaticMarkup(<OutputsTab {...TAB_PROPS(project)} />);
    expect(html).toContain('data-component="FilesSkeleton"');
    expect(html).toContain("2 MOUs in docx");
  });

  it("OutputsPanel decodes escaped specs too", () => {
    const html = renderToStaticMarkup(<OutputsPanel slug="mou" outputs={[DELIVERED]} />);
    expect(html).toContain("青田與合作方");
    expect(html).not.toContain("\\u9752");
  });
});
