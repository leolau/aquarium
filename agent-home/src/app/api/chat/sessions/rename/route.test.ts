/** BFF tests for the conversation title route (GET read, PATCH rename). */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET, PATCH } from "@/app/api/chat/sessions/rename/route";
import { HermesApiError } from "@/lib/api/client";
import type { Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const request = vi.fn();
const renameSession = vi.fn();
const apiClientForRequest = vi.fn<(opts: { profile?: string }) => Promise<unknown>>(
  async () => ({ request, renameSession }),
);

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: (opts: { profile?: string }) => apiClientForRequest(opts),
}));

const principal: Principal = {
  user_id: "mia",
  display: "Mia",
  role: "member",
  channels: [],
  is_owner: false,
};

describe("/api/chat/sessions/rename", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPrincipal.mockResolvedValue(principal);
  });

  it("401s without a principal", async () => {
    getPrincipal.mockResolvedValue(null);
    expect((await GET(new Request("http://x/api/chat/sessions/rename?sessionId=s1"))).status).toBe(
      401,
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("GET reads one session's title under the requested profile", async () => {
    request.mockResolvedValue({ id: "s1", title: "Trip", preview: "x" });
    const res = await GET(
      new Request("http://x/api/chat/sessions/rename?sessionId=s1&profile=research"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ session_id: "s1", title: "Trip" });
    expect(request).toHaveBeenCalledWith("/api/sessions/s1");
    expect(apiClientForRequest).toHaveBeenCalledWith({ profile: "research" });
  });

  it("GET maps an untitled session to null and needs a session id", async () => {
    request.mockResolvedValue({ id: "s1", title: "" });
    const res = await GET(new Request("http://x/api/chat/sessions/rename?sessionId=s1"));
    expect(await res.json()).toEqual({ session_id: "s1", title: null });
    expect((await GET(new Request("http://x/api/chat/sessions/rename"))).status).toBe(400);
  });

  it("GET passes upstream errors through", async () => {
    request.mockRejectedValue(new HermesApiError(404, "Session not found"));
    const res = await GET(new Request("http://x/api/chat/sessions/rename?sessionId=nope"));
    expect(res.status).toBe(404);
  });

  it("PATCH renames", async () => {
    renameSession.mockResolvedValue({ ok: true, title: "Mine" });
    const res = await PATCH(
      new Request("http://x/api/chat/sessions/rename", {
        method: "PATCH",
        body: JSON.stringify({ sessionId: "s1", title: "Mine", profile: "research" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, title: "Mine" });
    expect(renameSession).toHaveBeenCalledWith("s1", "Mine");
    expect(apiClientForRequest).toHaveBeenCalledWith({ profile: "research" });
  });
});
