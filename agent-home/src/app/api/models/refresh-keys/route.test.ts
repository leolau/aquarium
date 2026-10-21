/** BFF route test for POST /api/models/refresh-keys (owners/admins only). */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/models/refresh-keys/route";
import type { Principal, RefreshKeysResponse } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const refreshProviderKeys = vi.fn(
  async (): Promise<RefreshKeysResponse> => ({ ok: true, reloaded: 1, cleared: { "opencode-go": 1 } }),
);

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async () => ({ refreshProviderKeys }),
}));

const req = () => new Request("http://home.test/api/models/refresh-keys", { method: "POST" });

describe("POST /api/models/refresh-keys", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refreshes for an owner", async () => {
    getPrincipal.mockResolvedValue({ user_id: "leo", display: "Leo", role: "owner", channels: [], is_owner: true });
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect((await res.json()).cleared).toEqual({ "opencode-go": 1 });
  });

  it("refuses a member", async () => {
    getPrincipal.mockResolvedValue({ user_id: "mia", display: "Mia", role: "member", channels: [], is_owner: false });
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect(refreshProviderKeys).not.toHaveBeenCalled();
  });
});
