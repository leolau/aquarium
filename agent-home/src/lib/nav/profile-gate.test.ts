import { describe, expect, it } from "vitest";

import { gatedToDefaultProfile } from "@/lib/nav/profile-gate";

describe("gatedToDefaultProfile (FG-28 B3)", () => {
  it("gates nothing for a default-profile session (single-profile installs unchanged)", () => {
    for (const path of ["/", "/goals", "/memory", "/settings/backups", "/projects/x"]) {
      expect(gatedToDefaultProfile(path, "default")).toBe(false);
      expect(gatedToDefaultProfile(path, undefined)).toBe(false);
    }
  });

  it("gates pages that read only the default profile while the session is elsewhere", () => {
    for (const path of ["/", "/goals", "/memory", "/projects/acme", "/todos", "/settings/backups", "/files"]) {
      expect(gatedToDefaultProfile(path, "hr")).toBe(true);
    }
  });

  it("does not let an encoded or dotted path slip past the gate", () => {
    for (const path of ["/%74odos", "//todos/", "/chat/../memory", "/skills/readme.md"]) {
      expect(gatedToDefaultProfile(path, "hr")).toBe(true);
    }
  });

  it("leaves the profile-aware pages, sign-in pages, APIs and static files alone", () => {
    for (const path of ["/chat", "/chat/", "/users", "/members", "/login", "/default-profile-only", "/api/goals", "/sw.js", "/manifest.webmanifest", "/icons/a.png", "/apps/x/"]) {
      expect(gatedToDefaultProfile(path, "hr")).toBe(false);
    }
  });
});
