// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { newTabRel } from "./link-rel";

describe("newTabRel", () => {
  it("keeps the Referer for this site's own routes", () => {
    expect(newTabRel("/api/projects/p/artifacts/d:1/content")).toBe("noopener");
    expect(newTabRel(`${window.location.origin}/api/files/abc/content?download=1`)).toBe("noopener");
  });

  it("drops the Referer for other sites", () => {
    expect(newTabRel("https://docs.google.com/document/d/x")).toBe("noopener noreferrer");
    expect(newTabRel("//evil.example/x")).toBe("noopener noreferrer");
    expect(newTabRel(null)).toBe("noopener noreferrer");
  });
});
