// @vitest-environment jsdom
/**
 * Composers report how high they reach from the viewport bottom so the
 * floating lead-chat launcher can sit above their Send controls.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  composerClearance,
  dockComposer,
  useComposerClearance,
} from "@/lib/chat/composer-dock";

function box(rect: Partial<DOMRect>): HTMLElement {
  const el = document.createElement("div");
  el.getBoundingClientRect = () =>
    ({
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
      width: 0,
      height: 0,
      ...rect,
    }) as DOMRect;
  return el;
}

function viewport(width: number, height: number) {
  vi.stubGlobal("innerWidth", width);
  vi.stubGlobal("innerHeight", height);
}

afterEach(() => vi.unstubAllGlobals());

describe("composer clearance", () => {
  it("is the composer's height above the bottom at desktop 1280x820", () => {
    viewport(1280, 820);
    expect(
      composerClearance(
        box({
          top: 690,
          bottom: 820,
          left: 300,
          right: 1264,
          width: 964,
          height: 130,
        }),
      ),
    ).toBe(130);
  });

  it("covers a full-width phone composer at 390px, including the safe-area inset", () => {
    viewport(390, 844);
    expect(
      composerClearance(
        box({
          top: 700,
          bottom: 810,
          left: 56,
          right: 382,
          width: 326,
          height: 110,
        }),
      ),
    ).toBe(144);
  });

  it("is zero for a composer away from the launcher's corner or not laid out", () => {
    viewport(1280, 820);
    expect(
      composerClearance(
        box({
          top: 300,
          bottom: 420,
          left: 300,
          right: 1264,
          width: 964,
          height: 120,
        }),
      ),
    ).toBe(0);
    expect(
      composerClearance(
        box({
          top: 700,
          bottom: 820,
          left: 0,
          right: 640,
          width: 640,
          height: 120,
        }),
      ),
    ).toBe(0);
    expect(composerClearance(box({}))).toBe(0);
  });

  it("tracks the tallest docked composer and drops back when they undock", () => {
    viewport(1280, 820);
    const { result } = renderHook(() => useComposerClearance());
    expect(result.current).toBe(0);
    let undockA = () => {};
    let undockB = () => {};
    act(() => {
      undockA = dockComposer(
        box({
          top: 700,
          bottom: 820,
          left: 0,
          right: 1280,
          width: 1280,
          height: 120,
        }),
      );
    });
    expect(result.current).toBe(120);
    act(() => {
      undockB = dockComposer(
        box({
          top: 600,
          bottom: 820,
          left: 0,
          right: 1280,
          width: 1280,
          height: 220,
        }),
      );
    });
    expect(result.current).toBe(220);
    act(() => undockB());
    expect(result.current).toBe(120);
    act(() => undockA());
    expect(result.current).toBe(0);
  });
});
