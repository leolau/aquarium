// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LEGEND_HIDE_MS, creatureSprite } from "@/lib/aquarium/creatures";

import { AquariumLegend } from "./AquariumLegend";

const legend = () => document.querySelector('[data-component="AquariumLegend"]')!;
const toggle = () => document.querySelector<HTMLButtonElement>('[data-action="aquarium-legend-toggle"]')!;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("AquariumLegend", () => {
  it("is open on load with a labelled region and sprite swatches for every row", () => {
    render(<AquariumLegend />);
    expect(legend().getAttribute("data-state")).toBe("open");
    const region = screen.getByRole("region", { name: "How to read the aquarium" });
    expect(region.querySelectorAll("[data-legend-row]")).toHaveLength(5);
    for (const row of region.querySelectorAll("[data-legend-row]")) {
      expect(row.querySelector(`img[src="${creatureSprite("clownfish")}"]`)).not.toBeNull();
    }
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(toggle().getAttribute("aria-controls")).toBe(region.id);
  });

  it("hides after LEGEND_HIDE_MS and the info button brings it back, then hides again", () => {
    render(<AquariumLegend />);
    act(() => void vi.advanceTimersByTime(LEGEND_HIDE_MS - 1));
    expect(legend().getAttribute("data-state")).toBe("open");
    act(() => void vi.advanceTimersByTime(1));
    expect(legend().getAttribute("data-state")).toBe("closed");
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(toggle().getAttribute("aria-label")).toBe("Show how to read the aquarium");

    fireEvent.click(toggle());
    expect(legend().getAttribute("data-state")).toBe("open");
    act(() => void vi.advanceTimersByTime(LEGEND_HIDE_MS));
    expect(legend().getAttribute("data-state")).toBe("closed");
  });

  it("stays up while hovered and hides after the delay once the pointer leaves", () => {
    render(<AquariumLegend />);
    fireEvent.pointerEnter(legend(), { pointerType: "mouse" });
    act(() => void vi.advanceTimersByTime(LEGEND_HIDE_MS * 3));
    expect(legend().getAttribute("data-state")).toBe("open");
    fireEvent.pointerLeave(legend(), { pointerType: "mouse" });
    act(() => void vi.advanceTimersByTime(LEGEND_HIDE_MS));
    expect(legend().getAttribute("data-state")).toBe("closed");
  });

  it("closes on Escape", () => {
    render(<AquariumLegend />);
    fireEvent.keyDown(toggle(), { key: "Escape" });
    expect(legend().getAttribute("data-state")).toBe("closed");
  });

  it("fades with a transition that reduced motion turns off", () => {
    render(<AquariumLegend />);
    const region = screen.getByRole("region");
    expect(region.className).toContain("transition-");
    expect(region.className).toContain("motion-reduce:transition-none");
  });
});
