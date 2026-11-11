import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST as attention } from "@/app/api/incomings/[id]/attention/route";
import { GET as count } from "@/app/api/incomings/attention-count/route";
import { GET as list } from "@/app/api/incomings/route";
import { HermesApiError } from "@/lib/api/client";
import type { Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const client = {
  incomings: vi.fn(),
  incomingsAttentionCount: vi.fn(),
  setIncomingAttention: vi.fn(),
};

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async () => client,
}));

const ada: Principal = { user_id: "ada", display: "Ada", role: "member", channels: [], is_owner: false };

function post(id: string, body: unknown): Promise<Response> {
  return attention(
    new Request(`http://home.test/api/incomings/${id}/attention`, {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  ) as unknown as Promise<Response>;
}

describe("incomings attention BFF", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPrincipal.mockResolvedValue(ada);
  });

  it("forwards attention=open|cleared|any to the list and drops anything else", async () => {
    client.incomings.mockResolvedValue({ items: [], next_cursor: null });
    await list(new Request("http://home.test/api/incomings?attention=open&limit=50") as never);
    expect(client.incomings).toHaveBeenLastCalledWith(expect.objectContaining({ attention: "open" }));
    await list(new Request("http://home.test/api/incomings?attention=bogus") as never);
    expect(client.incomings).toHaveBeenLastCalledWith(expect.objectContaining({ attention: undefined }));
  });

  it("returns the attention count as upstream sends it", async () => {
    const body = { count: 7, urgent: 2, by_surface: { email: 4, whatsapp: 2, calendar: 1 } };
    client.incomingsAttentionCount.mockResolvedValue(body);
    const res = await count();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(body);
  });

  it("is 401 without a principal and never calls upstream", async () => {
    getPrincipal.mockResolvedValue(null);
    expect((await count()).status).toBe(401);
    expect((await post("a1", { action: "reopen" })).status).toBe(401);
    expect(client.incomingsAttentionCount).not.toHaveBeenCalled();
    expect(client.setIncomingAttention).not.toHaveBeenCalled();
  });

  it("passes clear and reopen through", async () => {
    client.setIncomingAttention.mockResolvedValue({ id: "a1" });
    expect((await post("a1", { action: "clear", outcome: "done" })).status).toBe(200);
    expect(client.setIncomingAttention).toHaveBeenLastCalledWith("a1", { action: "clear", outcome: "done" });
    await post("a1", { action: "clear", outcome: "dismissed" });
    expect(client.setIncomingAttention).toHaveBeenLastCalledWith("a1", { action: "clear", outcome: "dismissed" });
    await post("a1", { action: "reopen", outcome: "done" });
    expect(client.setIncomingAttention).toHaveBeenLastCalledWith("a1", { action: "reopen" });
  });

  it("rejects a malformed body with 400 before calling upstream", async () => {
    for (const body of ["not json", { action: "clear" }, { action: "clear", outcome: "later" }, { action: "snooze" }]) {
      expect((await post("a1", body)).status).toBe(400);
    }
    expect(client.setIncomingAttention).not.toHaveBeenCalled();
  });

  it("passes upstream 403 (not the owner) and 404 through, and 502 when unreachable", async () => {
    client.setIncomingAttention.mockRejectedValueOnce(new HermesApiError(403, "forbidden"));
    expect((await post("a1", { action: "reopen" })).status).toBe(403);
    client.setIncomingAttention.mockRejectedValueOnce(new HermesApiError(404, "missing"));
    expect((await post("a1", { action: "reopen" })).status).toBe(404);
    client.incomingsAttentionCount.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect((await count()).status).toBe(502);
  });
});
