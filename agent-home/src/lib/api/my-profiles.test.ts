import { describe, expect, it } from "vitest";

import { activeEnrolments, administeredProfiles, selectUsersProfile } from "@/lib/api/my-profiles";
import type { MyProfilesResponse } from "@/types";

const MINE: MyProfilesResponse = {
  profiles: [
    { name: "default", role: "member", active: true, is_default: true },
    { name: "hr", role: "admin", active: true, is_default: false },
    { name: "ops", role: "owner", active: true, is_default: false },
    { name: "finance", role: "admin", active: false, is_default: false },
  ],
};

describe("administeredProfiles (FG-28 C3)", () => {
  it("is the active enrolments held as owner or admin — a subset of where one may chat", () => {
    const administered = administeredProfiles(MINE).map((p) => p.name);
    expect(administered).toEqual(["hr", "ops"]);
    const enrolled = activeEnrolments(MINE).map((p) => p.name);
    for (const name of administered) expect(enrolled).toContain(name);
  });
});

describe("selectUsersProfile", () => {
  const administered = administeredProfiles(MINE);

  it("shows a requested profile the account administers", () => {
    expect(selectUsersProfile("hr", administered, "default")).toBe("hr");
    expect(selectUsersProfile(" ops ", administered, "default")).toBe("ops");
  });

  it("falls back to the session's profile for anything not administered", () => {
    for (const requested of ["default", "finance", "nope", "", undefined]) {
      expect(selectUsersProfile(requested, administered, "default")).toBe("default");
    }
    expect(selectUsersProfile("finance", administered, "hr")).toBe("hr");
  });
});
