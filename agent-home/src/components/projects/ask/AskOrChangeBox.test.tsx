import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects",
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

import { AskOrChangeBox } from "@/components/projects/ask/AskOrChangeBox";
import { askProjectFixture } from "@/components/projects/ask/fixture.test-utils";

describe("AskOrChangeBox (SSR)", () => {
  const html = renderToStaticMarkup(
    <AskOrChangeBox project={askProjectFixture()} onChangeRequest={() => {}} />,
  );

  it("renders the ask/change toggle with ask selected", () => {
    expect(html).toContain('data-component="AskOrChangeBox"');
    expect(html).toContain("💬 Ask about this project");
    expect(html).toContain("＋ Add requirement / change");
    expect(html).toMatch(/aria-pressed="true"[^>]*data-mode="ask"/);
    expect(html).toMatch(/aria-pressed="false"[^>]*data-mode="change"/);
  });

  it("shows the read-only hint, textarea, suggestions and a disabled Ask", () => {
    expect(html).toContain("It only reads");
    expect(html).toContain("<textarea");
    expect(html).toContain("What&#x27;s left?");
    expect(html).toContain("What changed since the last run?");
    expect(html).toContain("Why is it slow?");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Ask<\/button>/);
  });

  it("renders no thread before anything was asked", () => {
    expect(html).not.toContain("data-thread");
  });
});
