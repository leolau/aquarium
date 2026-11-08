// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LONG_RUN_MS } from "@/components/ui/useActivityRunning";

import { MobileActivityStrip } from "./MobileActivityStrip";
import { MOCK_ACTIVITY, MOCK_NOW } from "./mockData";

afterEach(cleanup);

describe("MobileActivityStrip", () => {
  it("renders nothing when nothing is running", () => {
    const { container } = render(<MobileActivityStrip items={[]} now={MOCK_NOW} />);
    expect(container.innerHTML).toBe("");
  });

  it("summarises in one line and expands to every item with links", () => {
    render(<MobileActivityStrip items={MOCK_ACTIVITY} now={MOCK_NOW} />);
    expect(screen.getByTestId("activity-count").textContent).toBe("4 working · 1 waiting");
    const toggle = screen.getByRole("button");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const links = screen.getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(MOCK_ACTIVITY.map((i) => i.href));
  });

  it("turns amber for a long run and dims stale data", () => {
    const long = [{ ...MOCK_ACTIVITY[0], started_at: (MOCK_NOW - LONG_RUN_MS - 1000) / 1000 }];
    const { container } = render(<MobileActivityStrip items={long} now={MOCK_NOW} stale />);
    const root = container.querySelector('[data-component="MobileActivityStrip"]')!;
    expect(root.getAttribute("data-stale")).toBe("true");
    expect(root.querySelector("svg")!.getAttribute("class")).toContain("--color-warn");
  });
});
