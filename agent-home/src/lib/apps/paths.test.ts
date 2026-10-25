import { describe, expect, it } from "vitest";

import { isAppPath, isWithinApp, parseAppPath } from "@/lib/apps/paths";

describe("app paths (decision 4)", () => {
  it("maps /apps/<slug> to prod and /apps-dev/<slug> to dev", () => {
    expect(parseAppPath("/apps/notes/board?x=1")).toEqual({
      slug: "notes",
      mode: "prod",
      base: "/apps/notes",
    });
    expect(parseAppPath("/apps-dev/notes")).toEqual({
      slug: "notes",
      mode: "dev",
      base: "/apps-dev/notes",
    });
  });

  it("refuses anything that is not unambiguously one app", () => {
    for (const uri of [
      "",
      "apps/notes/",
      "/apps",
      "/apps/",
      "/application/notes",
      "/apps/notes/../other/",
      "/apps/./notes/",
      "/apps/notes%2F..%2Fother/",
      "/apps/%2e%2e/x",
      "/apps/notes\\..\\other",
      "/apps/-bad/",
      "/api/tools",
    ]) {
      expect(parseAppPath(uri), uri).toBeNull();
    }
  });

  it("keeps a slug that is a prefix of another slug inside its own app", () => {
    const notes = parseAppPath("/apps/notes/")!;
    expect(isWithinApp("/apps/notes/x", notes)).toBe(true);
    expect(isWithinApp("/apps/notes", notes)).toBe(true);
    expect(isWithinApp("/apps/notes2/x", notes)).toBe(false);
    expect(isWithinApp("/apps-dev/notes/x", notes)).toBe(false);
  });

  it("classifies both prefixes as app pages and nothing else", () => {
    expect(isAppPath("/apps/x")).toBe(true);
    expect(isAppPath("/apps-dev/x")).toBe(true);
    expect(isAppPath("/apps")).toBe(true);
    expect(isAppPath("/application")).toBe(false);
    expect(isAppPath("/tools")).toBe(false);
  });
});
