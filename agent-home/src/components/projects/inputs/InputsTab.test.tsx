import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects",
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

import { LINK, PROJECT } from "@/components/projects/inputs/fixtures.test-helpers";
import { MemoriesPanel } from "@/components/projects/panels/MemoriesPanel";
import { InputsTab } from "@/components/projects/tabs/InputsTab";
import type { ProjectTabProps } from "@/components/projects/tabs/types";
import type { ProjectDetail } from "@/types";

function tab(project: ProjectDetail): string {
  const props = {
    project,
    board: null,
    playbook: null,
    directives: null,
    doctor: null,
    callerUserId: "leo",
    canLead: true,
    readiness: [],
    runnable: true,
    onNavigate: () => {},
    onChangeRequest: () => {},
  } satisfies ProjectTabProps;
  return renderToStaticMarkup(<InputsTab {...props} />);
}

describe("InputsTab (SSR)", () => {
  it("asks for inputs when the project has none, with every add control", () => {
    const html = tab(PROJECT);
    expect(html).toContain('data-component="InputsEmptyState"');
    expect(html).toContain("Do you have anything the agent should use?");
    expect(html).toContain('data-component="FileDropZone"');
    expect(html).toContain("Upload file");
    // The memory search is already open on an empty project.
    expect(html).toContain('aria-label="Search memory"');
    expect(html).toContain('data-component="LinkNoteInput"');
  });

  it("lists files, memories and links with role, who and when, and Remove", () => {
    const html = tab({
      ...PROJECT,
      links: {
        sample: [LINK({ kind: "sample", ref: "leo/mou/MOU_template.docx", label: "MOU_template.docx" })],
        reference: [
          LINK({ kind: "reference", ref: "leo/mou/terms.pdf", label: "terms.pdf", added_by: "yan" }),
          LINK({ kind: "reference", ref: "note:Keep it under one page", label: null }),
        ],
        memory: [LINK({ kind: "memory", ref: "mem_1", label: "ConnectAR Ltd company details" })],
        url: [LINK({ kind: "url", ref: "https://drive.google.com/x", label: "Agreements folder" })],
      },
    });
    expect(html).not.toContain('data-component="InputsEmptyState"');
    expect(html).toContain("MOU_template.docx");
    expect(html).toMatch(/Template to match · added by you · \d{4}-\d{2}-\d{2}/);
    expect(html).toMatch(/Reference to read · added by yan · \d{4}-\d{2}-\d{2}/);
    expect(html).toContain("ConnectAR Ltd company details");
    expect(html).toContain("Memory · added by you");
    expect(html).toContain("Keep it under one page");
    expect(html).toContain("Note · added by you");
    expect(html).toContain("Agreements folder");
    expect(html).toContain('href="https://drive.google.com/x"');
    expect(html).toContain('aria-label="Remove MOU_template.docx"');
    expect(html).toContain('aria-label="Remove ConnectAR Ltd company details"');
    // The files section holds the uploads, not the note or the URL.
    const files = html.slice(html.indexOf('id="panel-files"'), html.indexOf('id="panel-memories"'));
    expect(files).toContain("terms.pdf");
    expect(files).not.toContain("Keep it under one page");
    expect(files).not.toContain("Agreements folder");
  });

  it("an archived project shows its inputs without any add or remove controls", () => {
    const html = tab({
      ...PROJECT,
      archived: true,
      links: { memory: [LINK({ kind: "memory", ref: "mem_1", label: "Company details" })] },
    });
    expect(html).toContain("Company details");
    expect(html).not.toContain("Remove");
    expect(html).not.toContain('data-component="FileDropZone"');
    expect(html).not.toContain("Add memory");
    expect(html).not.toContain('data-component="InputsEmptyState"');
  });
});

describe("MemoriesPanel (SSR)", () => {
  it("never renders nothing: empty shows the ask and Add memory", () => {
    const html = renderToStaticMarkup(<MemoriesPanel project={PROJECT} />);
    expect(html).toContain('data-component="MemoriesPanel"');
    expect(html).toContain("No memories linked yet");
    expect(html).toContain("Add memory");
  });
});
