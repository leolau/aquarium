// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NeedsYouBadge } from "./NeedsYouBadge";

afterEach(cleanup);

describe("NeedsYouBadge", () => {
  it("is amber with the count when something needs you, and opens the panel", () => {
    const onOpen = vi.fn();
    render(<NeedsYouBadge count={3} onOpen={onOpen} />);
    const btn = screen.getByRole("button");
    expect(btn.textContent).toContain("3 need you");
    expect(btn.getAttribute("data-state")).toBe("some");
    expect(btn.className).toContain("--color-warn");
    fireEvent.click(btn);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("uses the singular for one item", () => {
    render(<NeedsYouBadge count={1} />);
    expect(screen.getByRole("button").textContent).toContain("1 needs you");
  });

  it("is green 'All clear' at zero", () => {
    render(<NeedsYouBadge count={0} />);
    const btn = screen.getByRole("button");
    expect(btn.textContent).toContain("All clear");
    expect(btn.getAttribute("data-state")).toBe("none");
    expect(btn.className).toContain("--color-success");
  });

  it("shows only the number in the compact (mobile) form, with a full accessible name", () => {
    render(<NeedsYouBadge compact count={4} />);
    const btn = screen.getByRole("button");
    expect(btn.textContent?.trim()).toBe("4");
    expect(btn.getAttribute("aria-label")).toMatch(/4/);
  });

  it("is neutral before the first read", () => {
    render(<NeedsYouBadge count={null} />);
    expect(screen.getByRole("button").getAttribute("data-state")).toBe("unknown");
  });
});
