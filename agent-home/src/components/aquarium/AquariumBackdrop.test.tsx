// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decorSprite } from "@/lib/aquarium/creatures";

import { AquariumBackdrop } from "./AquariumBackdrop";

function stubMotion(reduced: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: reduced, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
}

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AquariumBackdrop", () => {
  it("shows the Canva backdrop behind a scenery canvas and starts one animation loop", () => {
    stubMotion(false);
    const { container } = render(<AquariumBackdrop />);
    const root = container.querySelector('[data-component="AquariumBackdrop"]') as HTMLElement;
    expect(root.getAttribute("aria-hidden")).toBe("true");
    expect(root.innerHTML).toContain(decorSprite("backdrop"));
    expect(container.querySelector('canvas[data-component="AquariumScenery"]')).not.toBeNull();
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
  });

  it("paints a still frame without an animation loop under reduced motion", () => {
    stubMotion(true);
    render(<AquariumBackdrop />);
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });

  it("stops the loop when the tab is hidden", () => {
    stubMotion(false);
    render(<AquariumBackdrop />);
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(cancelAnimationFrame).toHaveBeenCalled();
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
  });
});
