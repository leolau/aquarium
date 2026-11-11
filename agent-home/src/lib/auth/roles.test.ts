import { describe, expect, it } from "vitest";

import { canUpgradeSoftware } from "@/lib/auth/roles";
import type { Role } from "@/types";

const as = (role: Role, is_owner = false) => ({ role, is_owner });

describe("canUpgradeSoftware", () => {
  it("lets the owner and admins upgrade and roll back", () => {
    expect(canUpgradeSoftware(as("owner", true))).toBe(true);
    expect(canUpgradeSoftware(as("admin"))).toBe(true);
  });

  it("keeps members and viewers out", () => {
    expect(canUpgradeSoftware(as("member"))).toBe(false);
    expect(canUpgradeSoftware(as("viewer"))).toBe(false);
  });
});
