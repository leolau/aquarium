/** Open + Download for a produced file. */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { InputRow } from "@/components/projects/inputs/InputRow";
import {
  downloadHref,
  OpenArtifact,
} from "@/components/projects/outputs/OpenArtifact";
import type { ProjectLink } from "@/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

const FILE = {
  title: "sheet.xlsx",
  link_kind: "workspace",
  link_ref: "/ws/t_1/out/sheet.xlsx",
};

describe("OpenArtifact", () => {
  it("a file served by the app gets a Download beside Open", () => {
    const href = "/api/projects/p/artifacts/f%3At_1%3Aab/content";
    const html = renderToStaticMarkup(
      <OpenArtifact file={{ ...FILE, href }} />,
    );
    expect(html).toContain('aria-label="Open sheet.xlsx"');
    expect(html).toContain(`href="${href}?download=1"`);
    expect(html).toContain('aria-label="Download sheet.xlsx"');
  });

  it("an external link (a Google Doc) has Open only", () => {
    const html = renderToStaticMarkup(
      <OpenArtifact
        file={{ ...FILE, link_kind: "url", href: "https://docs.google.com/x" }}
      />,
    );
    expect(html).toContain('aria-label="Open sheet.xlsx"');
    expect(html).not.toContain("Download");
  });

  it("a storage file ref downloads through the opener", () => {
    const html = renderToStaticMarkup(
      <OpenArtifact
        file={{
          title: "a.pdf",
          href: null,
          link_kind: "file",
          link_ref: "u/p/a.pdf",
        }}
        onOpenFile={async () => {}}
        onDownloadFile={async () => {}}
      />,
    );
    expect(html).toMatch(/<button[^>]*aria-label="Download a.pdf"/);
  });

  it("a deleted file offers neither", () => {
    const html = renderToStaticMarkup(
      <OpenArtifact
        file={{
          ...FILE,
          href: null,
          missing: true,
          location: "card workspace / out",
        }}
      />,
    );
    expect(html).not.toContain("Download");
  });

  it("downloadHref keeps an existing query", () => {
    expect(downloadHref("/api/x?y=1")).toBe("/api/x?y=1&download=1");
    expect(downloadHref("https://example.com/a.pdf")).toBeNull();
    expect(downloadHref(null)).toBeNull();
  });
});

describe("InputRow", () => {
  it("an input file has a Download control", () => {
    const link = {
      kind: "sample",
      ref: "leo/p/123e4567-e89b-12d3-a456-426614174000-Bid_sheet.xlsx",
      profile: "default",
      label: null,
      added_at: 0,
    } as unknown as ProjectLink;
    const html = renderToStaticMarkup(
      <InputRow slug="p" link={link} onOpen={() => {}} onDownload={() => {}} />,
    );
    expect(html).toContain('aria-label="Download Bid sheet.xlsx"');
  });
});
