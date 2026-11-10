// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { BusyRegion } from "@/components/ui/BusyRegion";
import { PageSkeleton } from "@/components/ui/PageSkeleton";
import { PanelLoading } from "@/components/ui/PanelLoading";
import { SLOW_WAIT_MS } from "@/components/ui/SlowHint";

const STILL = /Still working/;

/** The hint is timed in CSS: it must carry the delayed reveal, not show at once. */
function expectDelayedHint() {
  const hint = screen.getByText(STILL);
  expect(hint.classList.contains("aq-slow-hint")).toBe(true);
  expect(hint.style.animationDelay).toBe(`${SLOW_WAIT_MS}ms`);
}

describe("still-working hint", () => {
  afterEach(cleanup);

  it("PageSkeleton carries a delayed hint under its loading label", () => {
    render(<PageSkeleton />);
    expect(screen.getByText("Loading…")).toBeTruthy();
    expectDelayedHint();
  });

  it("PanelLoading shows placeholder rows plus the delayed hint", () => {
    const { container } = render(<PanelLoading label="Loading network folders…" />);
    expect(screen.getByText("Loading network folders…")).toBeTruthy();
    expect(container.querySelectorAll("[data-skeleton-row]").length).toBe(2);
    expectDelayedHint();
  });

  it("BusyRegion mounts the hint only while busy, so its delay restarts per request", () => {
    const { rerender } = render(
      <BusyRegion busy label="Loading your files…">
        <p>rows</p>
      </BusyRegion>,
    );
    expectDelayedHint();
    rerender(
      <BusyRegion busy={false} label="Loading your files…">
        <p>rows</p>
      </BusyRegion>,
    );
    expect(screen.queryByText(STILL)).toBeNull();
  });
});
