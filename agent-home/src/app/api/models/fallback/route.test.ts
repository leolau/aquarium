/**
 * BFF route tests for /api/models/fallback — anyone signed in reads the
 * backup-model list; only owners/admins replace it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET, PUT } from "@/app/api/models/fallback/route";
import type { FallbackModelsResponse, Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const fallbackModels = vi.fn(
  async (): Promise<FallbackModelsResponse> => ({ providers: [] }),
);
const setFallbackModels = vi.fn(
  async (providers: { provider: string; model: string }[]): Promise<FallbackModelsResponse> => ({
    providers,
  }),
);

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async () => ({ fallbackModels, setFallbackModels }),
}));

const OWNER: Principal = { user_id: "leo", display: "Leo", role: "owner", channels: [], is_owner: true };
const MEMBER: Principal = { user_id: "mia", display: "Mia", role: "member", channels: [], is_owner: false };

function put(body: unknown): Promise<Response> {
  return PUT(
    new Request("http://home.test/api/models/fallback", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  ) as unknown as Promise<Response>;
}

describe("/api/models/fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPrincipal.mockResolvedValue(OWNER);
  });

  it("reads the list for a signed-in member", async () => {
    getPrincipal.mockResolvedValue(MEMBER);
    fallbackModels.mockResolvedValue({ providers: [{ provider: "deepseek", model: "deepseek-v4-pro" }] });
    const res = await GET(new Request("http://home.test/api/models/fallback"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ providers: [{ provider: "deepseek", model: "deepseek-v4-pro" }] });
  });

  it("refuses a member's change", async () => {
    getPrincipal.mockResolvedValue(MEMBER);
    const res = await put({ providers: [] });
    expect(res.status).toBe(403);
    expect(setFallbackModels).not.toHaveBeenCalled();
  });

  it("forwards the owner's whole list in order", async () => {
    const providers = [
      { provider: "opencode-go", model: "qwen3.8-max" },
      { provider: "deepseek", model: "deepseek-v4-pro" },
    ];
    const res = await put({ providers });
    expect(res.status).toBe(200);
    expect(setFallbackModels).toHaveBeenCalledWith(providers);
  });

  it("rejects a malformed entry", async () => {
    const res = await put({ providers: [{ provider: "deepseek" }] });
    expect(res.status).toBe(400);
    expect(setFallbackModels).not.toHaveBeenCalled();
  });
});
