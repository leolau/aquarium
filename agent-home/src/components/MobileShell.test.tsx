import type { ComponentProps, ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// CoralHost (mounted by the shell unless opted out) calls usePathname —
// mock to a neutral path so the server-render stays pure.
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: () => {} }),
}));

import { MobileShell } from "@/components/MobileShell";

// Basic render test for the mobile shell. `showCoral={false}` skips the
// client-only CoralHost (usePathname) so this stays a pure server-render
// assertion, and skips the badge-count fetch entirely.
//
// The shell is an async server component (it awaits the To-dos badge count),
// and `renderToStaticMarkup` cannot render one: it suspends on synchronous
// input. Awaiting the component function and rendering the element it returns
// is the server-render equivalent, and keeps the assertions unchanged.
async function renderShell(
  props: ComponentProps<typeof MobileShell>,
): Promise<string> {
  return renderToStaticMarkup((await MobileShell(props)) as ReactElement);
}

describe("MobileShell", () => {
  it("renders the title, the data-component root, and safe-area padding", async () => {
    const html = await renderShell({
      title: "Sign in",
      showCoral: false,
      children: <p>hello</p>,
    });
    expect(html).toContain('data-component="MobileShell"');
    expect(html).toContain("Sign in");
    expect(html).toContain("hello");
    // safe-area inset is wired for the notch/home-indicator.
    expect(html).toContain("safe-top");
  });

  it("carries the adaptive breakpoints so it widens past a phone column", async () => {
    const html = await renderShell({
      title: "Home",
      showCoral: false,
      children: <p>panel</p>,
    });
    // Tablet widens the column; desktop keeps the centred wide layout.
    expect(html).toContain("md:max-w-2xl");
    expect(html).toContain("lg:max-w-none");
    expect(html).toContain("lg:max-w-5xl");
  });

  it("renders optional actions in the header alongside the title", async () => {
    const html = await renderShell({
      title: "Chat",
      showCoral: false,
      actions: <span>test-actions</span>,
      children: <p>panel</p>,
    });
    expect(html).toContain("Chat");
    expect(html).toContain("test-actions");
    // The header inner div uses justify-between so actions sit on the right.
    expect(html).toContain("justify-between");
  });

  it("mounts the Coral launcher when not opted out", async () => {
    // renderShell awaits the async shell; with showCoral left at its default
    // the CoralHost client component appears in the markup as a placeholder.
    const html = await renderShell({
      title: "Home",
      children: <p>panel</p>,
    });
    expect(html).toContain("CoralHost");
  });

  it("hideHeader keeps the top bar and launcher but drops the page header", async () => {
    const shown = await renderShell({ title: "Aquarium", children: <p>panel</p> });
    expect(shown).toContain('data-component="PageHeader"');
    const html = await renderShell({ title: "Aquarium", hideHeader: true, children: <p>panel</p> });
    expect(html).not.toContain('data-component="PageHeader"');
    expect(html).toContain("CoralHost");
    expect(html).toContain("panel");
  });
});
