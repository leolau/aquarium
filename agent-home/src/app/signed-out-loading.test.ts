import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const APP = join(__dirname);

/** Signed-out routes; each needs its own loading.tsx or the root one (with the launcher) shows. */
const SIGNED_OUT = ["login", "setup", "activate", "survey"];

describe("signed-out loading states", () => {
  it.each(SIGNED_OUT)("/%s has a launcher-free loading.tsx", (route) => {
    const file = join(APP, route, "loading.tsx");
    expect(existsSync(file)).toBe(true);
    const src = readFileSync(file, "utf8");
    const usesShell = src.includes("<MobileShell");
    if (usesShell) expect(src).toMatch(/<MobileShell[^>]*showCoral=\{false\}/);
    else expect(src).not.toMatch(/CoralHost|LeadChatHost/);
  });

  it("the root loading state shows the signed-in shell without a page header", () => {
    const src = readFileSync(join(APP, "loading.tsx"), "utf8");
    expect(src).toMatch(/<MobileShell[^>]*\bhideHeader\b/);
    expect(src).toContain("<RouteLoading");
  });
});
