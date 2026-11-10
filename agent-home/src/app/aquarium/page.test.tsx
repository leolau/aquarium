import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

const { requirePrincipal } = vi.hoisted(() => ({
  requirePrincipal: vi.fn(async () => ({ user_id: "u1", role: "member" })),
}));
vi.mock("@/lib/auth/principal", () => ({ requirePrincipal }));

import Page from "@/app/aquarium/page";
import { AquariumView } from "@/components/aquarium/AquariumView";

describe("app/aquarium", () => {
  it("requires a signed-in principal and renders the full-bleed view", async () => {
    const page = (await Page()) as ReactElement;
    expect(requirePrincipal).toHaveBeenCalled();
    expect(page.type).toBe(AquariumView);
  });
});
