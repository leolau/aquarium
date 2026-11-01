import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/incomings/[id]/route";
import { HermesApiError } from "@/lib/api/client";
import type { Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const incoming = vi.fn<(id: string) => Promise<unknown>>();

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async () => ({ incoming }),
}));

function get(id: string): Promise<Response> {
  return GET(new Request(`http://home.test/api/incomings/${id}`), {
    params: Promise.resolve({ id }),
  }) as unknown as Promise<Response>;
}

describe("GET /api/incomings/:id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPrincipal.mockResolvedValue({
      user_id: "ada",
      display: "Ada",
      role: "member",
      channels: [],
      is_owner: false,
    });
  });

  it("passes the upstream 404 for a missing or malformed id through", async () => {
    incoming.mockRejectedValue(
      new HermesApiError(404, "GET /api/registry/incomings/zz-smoke-missing → 404"),
    );
    const res = await get("zz-smoke-missing");
    expect(res.status).toBe(404);
    expect(incoming).toHaveBeenCalledWith("zz-smoke-missing");
  });

  it("is 401 without a principal and never calls upstream", async () => {
    getPrincipal.mockResolvedValue(null);
    const res = await get("zz-smoke-missing");
    expect(res.status).toBe(401);
    expect(incoming).not.toHaveBeenCalled();
  });

  it("returns the arrival when upstream has it", async () => {
    incoming.mockResolvedValue({ id: "11111111-1111-1111-1111-111111111111" });
    const res = await get("11111111-1111-1111-1111-111111111111");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "11111111-1111-1111-1111-111111111111" });
  });
});
