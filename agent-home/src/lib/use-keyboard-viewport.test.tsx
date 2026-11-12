// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KeyboardViewport, keyboardOpen } from "@/lib/use-keyboard-viewport";

class FakeVisualViewport extends EventTarget {
  height = 844;
  offsetTop = 0;
}

let vv: FakeVisualViewport;

beforeEach(() => {
  vv = new FakeVisualViewport();
  vi.stubGlobal("visualViewport", vv);
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    cb(0);
    return 0;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

const root = () => document.documentElement;

describe("keyboardOpen", () => {
  it("needs a focused field and a clearly shorter visual viewport", () => {
    expect(keyboardOpen(844, 500, true)).toBe(true);
    expect(keyboardOpen(844, 500, false)).toBe(false);
    expect(keyboardOpen(844, 780, true)).toBe(false);
  });
});

describe("KeyboardViewport", () => {
  it("mirrors the visual viewport and flags an open keyboard", () => {
    render(<KeyboardViewport />);
    expect(root().style.getPropertyValue("--vv-height")).toBe("844px");
    expect(root().dataset.keyboard).toBeUndefined();

    const field = document.createElement("textarea");
    document.body.appendChild(field);
    act(() => field.focus());
    act(() => {
      vv.height = 508;
      vv.offsetTop = 12;
      vv.dispatchEvent(new Event("resize"));
    });
    expect(root().dataset.keyboard).toBe("open");
    expect(root().style.getPropertyValue("--vv-height")).toBe("508px");
    expect(root().style.getPropertyValue("--vv-top")).toBe("12px");

    act(() => {
      vv.height = 844;
      vv.offsetTop = 0;
      vv.dispatchEvent(new Event("resize"));
    });
    expect(root().dataset.keyboard).toBeUndefined();
  });

  it("does not flag a keyboard when no text field has focus", () => {
    render(<KeyboardViewport />);
    act(() => {
      vv.height = 500;
      vv.dispatchEvent(new Event("resize"));
    });
    expect(root().dataset.keyboard).toBeUndefined();
  });

  it("clears its marks on unmount", () => {
    const field = document.createElement("input");
    document.body.appendChild(field);
    field.focus();
    vv.height = 500;
    const { unmount } = render(<KeyboardViewport />);
    expect(root().dataset.keyboard).toBe("open");
    unmount();
    expect(root().dataset.keyboard).toBeUndefined();
    expect(root().style.getPropertyValue("--vv-height")).toBe("");
  });
});
