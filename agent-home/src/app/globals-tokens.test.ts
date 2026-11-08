import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Every theme must resolve every design token components reference, so a
 * light/colourful user never falls back to an unset variable (or to
 * Tailwind's own defaults). Radii are theme-independent and live on :root.
 */
const css = readFileSync(resolve(__dirname, "globals.css"), "utf8");

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `${selector} block`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
}

function declared(body: string): string[] {
  return [...body.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]);
}

const THEME_COLORS = [
  "--color-bg",
  "--color-surface",
  "--color-surface-2",
  "--color-border",
  "--color-text",
  "--color-fg",
  "--color-muted",
  "--color-accent",
  "--color-accent-fg",
  "--color-warn",
  "--color-warn-text",
  "--color-success",
  "--color-danger",
  "--color-attention-bg",
];

describe("globals.css tokens", () => {
  it.each(['[data-theme="dark"]', '[data-theme="light"]', '[data-theme="colourful"]'])(
    "%s defines every colour token exactly once",
    (selector) => {
      const names = declared(block(selector));
      for (const token of THEME_COLORS) {
        expect(names.filter((n) => n === token), `${selector} ${token}`).toHaveLength(1);
      }
    },
  );

  it("defines the radius scale once, on :root, for every theme", () => {
    const root = declared(block(":root"));
    for (const r of ["sm", "md", "lg", "xl", "2xl"]) {
      expect(root.filter((n) => n === `--radius-${r}`)).toHaveLength(1);
    }
    expect(css.match(/--radius-lg\s*:/g)).toHaveLength(1);
  });

  it("every var(--token) used in src is declared in globals.css", async () => {
    const { readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const SRC = resolve(__dirname, "..");
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((e) => {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) return walk(p);
        return /\.(tsx?|css)$/.test(p) && !/\.test\.tsx?$/.test(p) ? [p] : [];
      });
    const defined = new Set(
      [...walk(SRC)].flatMap((p) => declared(readFileSync(p, "utf8"))),
    );
    // Set from component style props at runtime.
    defined.add("--coral-delay");
    const used = new Set<string>();
    for (const p of walk(SRC)) {
      for (const m of readFileSync(p, "utf8").matchAll(/var\((--[a-z0-9-]+)/g)) used.add(m[1]);
    }
    const missing = [...used].filter((t) => !defined.has(t));
    expect(missing).toEqual([]);
  });

  it("keeps the 44px touch-target floor to coarse pointers", () => {
    const idx = css.indexOf("min-height: 44px");
    expect(idx).toBeGreaterThan(0);
    expect(css.lastIndexOf("@media (pointer: coarse)", idx)).toBeGreaterThan(0);
    expect(css.match(/min-height: 44px/g)).toHaveLength(1);
  });

  it("breaks long unspaced text instead of widening the page", () => {
    const body = [...css.matchAll(/\nbody \{([^}]*)\}/g)].map((m) => m[1]).join("");
    expect(body).toMatch(/overflow-wrap:\s*break-word/);
  });
});
