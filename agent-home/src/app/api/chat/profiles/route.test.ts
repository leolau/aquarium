/**
 * BFF test for the chat profile picker's list (FG-28 D3): only the profiles
 * the signed-in account holds an active enrolment in, never the box's list.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/chat/profiles/route";
import { HermesApiError } from "@/lib/api/client";
import type { Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const client = { myProfiles: vi.fn(), profiles: vi.fn(), profileInfos: vi.fn() };

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async () => client,
}));

const member: Principal = {
  user_id: "bob",
  display: "Bob",
  role: "member",
  channels: [],
  is_owner: false,
};

describe("GET /api/chat/profiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is 401 when signed out, without asking Python", async () => {
    getPrincipal.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect(client.myProfiles).not.toHaveBeenCalled();
  });

  it("lists only the profiles the account is actively enrolled in", async () => {
    getPrincipal.mockResolvedValue(member);
    client.myProfiles.mockResolvedValue({
      profiles: [
        { name: "default", role: "member", active: true, is_default: true },
        { name: "hr", role: "admin", active: true, is_default: false },
        { name: "finance", role: "member", active: false, is_default: false },
      ],
    });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      profiles: [
        { name: "default", is_default: true, description: "" },
        { name: "hr", is_default: false, description: "" },
      ],
    });
    expect(client.profileInfos).not.toHaveBeenCalled();
  });

  it("passes an upstream refusal through", async () => {
    getPrincipal.mockResolvedValue(member);
    client.myProfiles.mockRejectedValue(new HermesApiError(401, "no subject"));
    expect((await GET()).status).toBe(401);
  });
});
