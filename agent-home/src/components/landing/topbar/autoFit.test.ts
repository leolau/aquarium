// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { FIT_STEPS, fitBar, overflowing } from "./autoFit";

/** A bar whose content width shrinks by `savings[step]` for each applied step. */
function fakeBar(widthOf: number | (() => number), content: number, savings: Record<string, number>) {
  const el = document.createElement("header");
  const width = () => (typeof widthOf === "number" ? widthOf : widthOf());
  const applied = () => (el.getAttribute("data-fit") ?? "").split(" ").filter(Boolean);
  Object.defineProperty(el, "clientWidth", { get: width });
  Object.defineProperty(el, "scrollWidth", {
    get: () => Math.max(width(), applied().reduce((w, s) => w - (savings[s] ?? 0), content)),
  });
  return el;
}

const SAVINGS = { updated: 90, "aquarium-label": 130, health: 300, "needs-text": 70, identity: 80 };

describe("fitBar", () => {
  it("leaves a bar that fits untouched", () => {
    const el = fakeBar(1440, 1200, SAVINGS);
    expect(fitBar(el)).toEqual([]);
    expect(el.hasAttribute("data-fit")).toBe(false);
  });

  it("drops only as many pieces as needed, least important first", () => {
    const el = fakeBar(1267, 1450, SAVINGS);
    expect(fitBar(el)).toEqual(["updated", "aquarium-label"]);
    expect(el.getAttribute("data-fit")).toBe("updated aquarium-label");
  });

  it("goes back to the full bar when it gets wider again", () => {
    let width = 1000;
    const el = fakeBar(() => width, 1450, SAVINGS);
    expect(fitBar(el)).toEqual(["updated", "aquarium-label", "health"]);
    width = 1600;
    expect(fitBar(el)).toEqual([]);
    expect(el.hasAttribute("data-fit")).toBe(false);
  });

  it("stops after the last step even if the bar still overflows", () => {
    const el = fakeBar(300, 2000, SAVINGS);
    expect(fitBar(el)).toEqual([...FIT_STEPS]);
  });
});

describe("overflowing", () => {
  it("detects a clipped watched piece", () => {
    const el = fakeBar(800, 800, {});
    const watch = document.createElement("button");
    watch.setAttribute("data-fit-watch", "");
    Object.defineProperty(watch, "clientWidth", { get: () => 100 });
    Object.defineProperty(watch, "scrollWidth", { get: () => 160 });
    el.appendChild(watch);
    expect(overflowing(el)).toBe(true);
  });

  it("detects two items overlapping", () => {
    const el = fakeBar(800, 800, {});
    const rect = (left: number, width: number) => () => ({ left, right: left + width, width }) as DOMRect;
    const a = document.createElement("div");
    const b = document.createElement("div");
    a.getBoundingClientRect = rect(600, 120);
    b.getBoundingClientRect = rect(690, 80);
    el.append(a, b);
    expect(overflowing(el)).toBe(true);
    b.getBoundingClientRect = rect(730, 60);
    expect(overflowing(el)).toBe(false);
  });

  it("detects the last item running into the bar's padding", () => {
    const el = fakeBar(800, 800, {});
    el.style.paddingRight = "16px";
    el.getBoundingClientRect = () => ({ left: 0, right: 800, width: 800 }) as DOMRect;
    const a = document.createElement("div");
    el.append(a);
    a.getBoundingClientRect = () => ({ left: 700, right: 791, width: 91 }) as DOMRect;
    expect(overflowing(el)).toBe(true);
    a.getBoundingClientRect = () => ({ left: 700, right: 784, width: 84 }) as DOMRect;
    expect(overflowing(el)).toBe(false);
  });
});
