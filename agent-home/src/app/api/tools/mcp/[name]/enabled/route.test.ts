/**
 * BFF route tests for POST /api/tools/mcp/[name]/enabled — the enable/
 * disable toggle the Tools & Integrations page fires. Contract: auth gate,
 * boolean-body validation, and upstream error mapping.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/tools/mcp/[name]/enabled/route";
import { HermesApiError } from "@/lib/api/client";
import type { Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const setMcpServerEnabled = vi.fn();

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async () => ({ setMcpServerEnabled }),
}));

function post(body: unknown): Promise<Response> {
  const req = new Request("http://x/api/tools/mcp/canva/enabled", {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return POST(req, {
    params: Promise.resolve({ name: "canva" }),
  }) as unknown as Promise<Response>;
}

describe("POST /api/tools/mcp/[name]/enabled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPrincipal.mockResolvedValue({
      user_id: "leo",
      display: "Leo",
      role: "owner",
      channels: [],
      is_owner: true,
    });
    setMcpServerEnabled.mockResolvedValue({ ok: true, name: "canva", enabled: false });
  });

  it("returns 401 when unauthenticated", async () => {
    getPrincipal.mockResolvedValue(null);
    const res = await post({ enabled: false });
    expect(res.status).toBe(401);
    expect(setMcpServerEnabled).not.toHaveBeenCalled();
  });

  it.each(["member", "viewer"] as const)(
    "returns 403 for a %s without calling upstream",
    async (role) => {
      getPrincipal.mockResolvedValue({
        user_id: "tom",
        display: "Tom",
        role,
        channels: [],
        is_owner: false,
      });
      const res = await post({ enabled: false });
      expect(res.status).toBe(403);
      expect((await res.json()).detail).toBe(
        "Only the owner or an admin can change tools and integrations.",
      );
      expect(setMcpServerEnabled).not.toHaveBeenCalled();
    },
  );

  it("lets an admin change the toggle", async () => {
    getPrincipal.mockResolvedValue({
      user_id: "ann",
      display: "Ann",
      role: "admin",
      channels: [],
      is_owner: false,
    });
    const res = await post({ enabled: false });
    expect(res.status).toBe(200);
    expect(setMcpServerEnabled).toHaveBeenCalledWith("canva", false);
  });

  it("forwards the toggle upstream", async () => {
    const res = await post({ enabled: false });
    expect(res.status).toBe(200);
    expect(setMcpServerEnabled).toHaveBeenCalledWith("canva", false);
  });

  it("rejects a non-boolean enabled", async () => {
    const res = await post({ enabled: "yes" });
    expect(res.status).toBe(400);
    expect(setMcpServerEnabled).not.toHaveBeenCalled();
  });

  it("maps an upstream API error", async () => {
    setMcpServerEnabled.mockRejectedValue(
      new HermesApiError(404, "Server 'canva' not found"),
    );
    const res = await post({ enabled: true });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.detail).toContain("not found");
  });

  it("maps an unreachable upstream to 502", async () => {
    setMcpServerEnabled.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await post({ enabled: true });
    expect(res.status).toBe(502);
  });
});
