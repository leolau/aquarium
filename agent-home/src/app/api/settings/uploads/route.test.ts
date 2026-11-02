import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET, PUT } from "@/app/api/settings/uploads/route";
import type { Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const request = vi.fn();

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async () => ({ request }),
}));

function as(role: Principal["role"]) {
  getPrincipal.mockResolvedValue({ user_id: "u", role, is_owner: role === "owner" } as Principal);
}

const put = (body: unknown) =>
  PUT(new Request("http://localhost/api/settings/uploads", { method: "PUT", body: JSON.stringify(body) }));

const GB = 1024 ** 3;

describe("/api/settings/uploads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    request.mockResolvedValue({ max_bytes: GB, default_max_bytes: GB });
  });

  it.each(["owner", "admin"] as const)("an %s can set the limit", async (role) => {
    as(role);
    const res = await put({ max_bytes: 2 * GB });
    expect(res.status).toBe(200);
    expect(request).toHaveBeenCalledWith("/api/agent-home/uploads", {
      method: "PUT",
      json: { max_bytes: 2 * GB },
    });
  });

  it.each(["member", "viewer"] as const)("a %s gets 403 and never reaches Python", async (role) => {
    as(role);
    expect((await put({ max_bytes: 2 * GB })).status).toBe(403);
    expect(request).not.toHaveBeenCalled();
  });

  it("401 when signed out", async () => {
    getPrincipal.mockResolvedValue(null);
    expect((await put({ max_bytes: 2 * GB })).status).toBe(401);
    expect((await GET()).status).toBe(401);
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects a non-integer limit before forwarding", async () => {
    as("owner");
    expect((await put({ max_bytes: "1GB" })).status).toBe(400);
    expect((await put({ max_bytes: 1.5 })).status).toBe(400);
    expect(request).not.toHaveBeenCalled();
  });

  it("any signed-in role can read it (the composer pre-checks against it), with the legacy override", async () => {
    vi.stubEnv("AGENT_HOME_UPLOAD_MAX_BYTES", "1048576");
    as("viewer");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ max_bytes: GB, legacy_override_bytes: 1048576 });
  });
});
