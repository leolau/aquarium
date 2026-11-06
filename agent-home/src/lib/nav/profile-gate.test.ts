import { describe, expect, it } from "vitest";

import { gatedToDefaultProfile } from "@/lib/nav/profile-gate";

describe("gatedToDefaultProfile (FG-28 B3)", () => {
  it("gates nothing for a default-profile session (single-profile installs unchanged)", () => {
    for (const path of ["/", "/files", "/capacity", "/settings/upgrade", "/memory"]) {
      expect(gatedToDefaultProfile(path, "default")).toBe(false);
      expect(gatedToDefaultProfile(path, undefined)).toBe(false);
    }
  });

  it("keeps whole-box pages in the default profile while the session is elsewhere", () => {
    for (const path of ["/files", "/files/browse", "/capacity", "/settings/upgrade"]) {
      expect(gatedToDefaultProfile(path, "hr")).toBe(true);
    }
  });

  it("does not let an encoded or dotted path slip past the gate", () => {
    for (const path of ["/%66iles", "//capacity/", "/chat/../files/browse"]) {
      expect(gatedToDefaultProfile(path, "hr")).toBe(true);
    }
  });

  it("lets profile-local pages follow the session profile", () => {
    for (const path of ["/", "/chat", "/memory", "/projects/acme", "/todos", "/settings", "/filesystem", "/api/files", "/default-profile-only"]) {
      expect(gatedToDefaultProfile(path, "hr")).toBe(false);
    }
  });
});
