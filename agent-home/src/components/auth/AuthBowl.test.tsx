// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AuthBowl } from "./AuthBowl";

afterEach(cleanup);

const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
const reducedMotion = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce) {\n  .aq-bowl-float"));

describe("AuthBowl", () => {
  it("is decorative: hidden from assistive tech, with an empty alt", () => {
    const { container } = render(<AuthBowl />);
    const root = container.querySelector('[data-component="AuthBowl"]')!;
    expect(root.getAttribute("aria-hidden")).toBe("true");
    expect(root.querySelector("img")!.getAttribute("alt")).toBe("");
  });

  it("floats the bowl and twinkles the stars with CSS classes, sized by the artwork's ratio", () => {
    const { container } = render(<AuthBowl />);
    const root = container.querySelector('[data-component="AuthBowl"]')!;
    expect(root.classList.contains("aq-bowl")).toBe(true);
    expect(root.querySelector(".aq-bowl-float img")).not.toBeNull();
    const stars = root.querySelectorAll(".aq-bowl-star");
    expect(stars.length).toBeGreaterThan(0);
    stars.forEach((s) => expect((s as SVGElement).style.left).toMatch(/%$/));
    const img = root.querySelector("img")!;
    expect(img.getAttribute("width")).toBeTruthy();
    expect(img.getAttribute("height")).toBeTruthy();
  });

  it("under reduced motion stops the float and the twinkle but keeps the fade-in", () => {
    expect(css).toMatch(/\.aq-bowl \{\s*animation: aq-bowl-in/);
    expect(reducedMotion).toMatch(/\.aq-bowl-float,\s*\.aq-bowl-star \{\s*animation: none;/);
    const block = reducedMotion.slice(0, reducedMotion.indexOf("\n}\n"));
    expect(block).not.toMatch(/\.aq-bowl[ ,{]/);
  });
});
