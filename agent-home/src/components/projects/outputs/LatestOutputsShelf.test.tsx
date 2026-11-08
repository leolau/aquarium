// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects",
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

import { LatestOutputsShelf } from "@/components/projects/outputs/LatestOutputsShelf";
import { ARTIFACT, DELIVERY, NOW, OUTPUT, PROJECT, json } from "@/components/projects/outputs/fixtures";

afterEach(() => cleanup());

const SIX = [
  ARTIFACT({ id: "a", title: "oldest.docx", created_at: NOW - 600 }),
  ARTIFACT({ id: "b", title: "brief.pdf", ext: "pdf", created_at: NOW - 100 }),
  ARTIFACT({ id: "c", title: "notes.md", kind: "note", created_at: NOW }),
  ARTIFACT({
    id: "d",
    title: "MOU final.docx",
    kind: "deliverable",
    output_id: "out_1",
    version: 2,
    run_no: 3,
    created_at: NOW - 50,
  }),
  ARTIFACT({ id: "e", title: "outline.md", ext: "md", created_at: NOW - 200 }),
  ARTIFACT({ id: "f", title: "plan.md", ext: "md", created_at: NOW - 300 }),
];

describe("LatestOutputsShelf", () => {
  it("shows the 4 newest deliverables/drafts with badge, pill and one Open each", () => {
    const html = renderToStaticMarkup(
      <LatestOutputsShelf
        project={PROJECT({ outputs: [OUTPUT({ id: "out_1", status: "in_progress" })] })}
        onShowAll={() => {}}
        initialArtifacts={SIX}
      />,
    );
    const titles = [...html.matchAll(/aria-label="Open ([^"]+)"/g)].map((m) => m[1]);
    expect(titles).toEqual(["MOU final.docx", "brief.pdf", "outline.md", "plan.md"]);
    expect(html).not.toContain("notes.md");
    expect(html).toContain("PDF");
    expect(html).toContain("writing");
    expect(html).toContain("draft");
    expect(html).toContain("Run 3");
    expect(html).toContain("All outputs &amp; drafts ›");
  });

  it("shows a skeleton before the read lands", () => {
    const html = renderToStaticMarkup(
      <LatestOutputsShelf project={PROJECT()} onShowAll={() => {}} />,
    );
    expect(html).toContain('data-component="ShelfSkeleton"');
  });

  it("fetches the artifacts read and has a graceful empty state", async () => {
    const fetchImpl = vi.fn(async () => json(200, []));
    const { findByText } = render(
      <LatestOutputsShelf project={PROJECT()} onShowAll={() => {}} fetchImpl={fetchImpl as unknown as typeof fetch} />,
    );
    expect(await findByText(/Nothing produced yet/)).toBeTruthy();
    expect(fetchImpl).toHaveBeenCalledWith("/api/projects/mou/artifacts");
  });

  it("falls back to the outputs' deliveries when the read fails", async () => {
    const fetchImpl = vi.fn(async () => json(502, { detail: "down" }));
    const project = PROJECT({
      outputs: [
        OUTPUT({
          status: "delivered",
          deliveries: [DELIVERY({ link_ref: "https://example.com/mou-v1.docx" })],
        }),
      ],
    });
    const { findByLabelText } = render(
      <LatestOutputsShelf project={project} onShowAll={() => {}} fetchImpl={fetchImpl as unknown as typeof fetch} />,
    );
    const open = await findByLabelText("Open mou-v1.docx");
    expect(open.getAttribute("href")).toBe("https://example.com/mou-v1.docx");
  });

  it("lays tiles out one per row with Open/Download in their own wrapping group", () => {
    // At 1440 px the shelf sits in half of the main column; a 2-up grid there
    // squeezed the metadata against the buttons. One tile per row, the text
    // block with a minimum width, and the actions free to wrap below it.
    const { container } = render(
      <LatestOutputsShelf
        project={PROJECT()}
        onShowAll={() => {}}
        initialArtifacts={[
          ARTIFACT({ id: "long", title: "a-very-long-quarterly-memorandum-of-understanding-final-v3.docx", run_no: 12 }),
        ]}
      />,
    );
    const list = container.querySelector('[data-component="OutputTiles"]')!;
    expect(list.className).not.toMatch(/grid-cols-2/);
    const tile = container.querySelector('[data-component="OutputTile"]')!;
    expect(tile.className).toContain("flex-wrap");
    const actions = tile.querySelector('[data-component="OutputTileActions"]')!;
    expect(actions.className).toContain("shrink-0");
    for (const name of [/^Open /, /^Download /]) {
      const control = [...actions.querySelectorAll("a,button")].find((el) =>
        name.test(el.getAttribute("aria-label") ?? ""),
      )!;
      expect(control, String(name)).toBeTruthy();
      // Tappable and never squeezed into a two-line label.
      expect(control.className).toContain("min-h-10");
      expect(control.className).toContain("whitespace-nowrap");
    }
  });

  it("All outputs & drafts calls onShowAll", async () => {
    const onShowAll = vi.fn();
    const { getByText } = render(
      <LatestOutputsShelf project={PROJECT()} onShowAll={onShowAll} initialArtifacts={[]} />,
    );
    fireEvent.click(getByText(/All outputs & drafts/));
    await waitFor(() => expect(onShowAll).toHaveBeenCalledTimes(1));
  });
});
