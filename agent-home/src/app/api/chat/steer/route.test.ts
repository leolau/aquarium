/**
 * POST /api/chat/steer and POST /api/chat/queue/remove: the BFF seam for
 * messages sent while a turn runs. Both copy `/api/chat/cancel`'s posture —
 * signed in, profile-scoped client — and forward the Python contract as is.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST as removePOST } from "@/app/api/chat/queue/remove/route";
import { POST as steerPOST } from "@/app/api/chat/steer/route";
import { HermesApiError } from "@/lib/api/client";
import type { Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const apiClientForRequest = vi.fn();
const steerChatRun = vi.fn();
const removeQueuedChatInput = vi.fn();

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: (opts: unknown) => apiClientForRequest(opts),
}));

function post(handler: (r: Request) => Promise<Response>, path: string, body: unknown) {
  return handler(
    new Request(`http://home.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}
const steer = (body: unknown) =>
  post(steerPOST as unknown as (r: Request) => Promise<Response>, "/api/chat/steer", body);
const remove = (body: unknown) =>
  post(removePOST as unknown as (r: Request) => Promise<Response>, "/api/chat/queue/remove", body);

beforeEach(() => {
  vi.clearAllMocks();
  getPrincipal.mockResolvedValue({
    user_id: "mia_member",
    display: "Mia",
    role: "member",
    channels: [],
    is_owner: false,
  });
  apiClientForRequest.mockResolvedValue({ steerChatRun, removeQueuedChatInput });
});

describe("POST /api/chat/steer", () => {
  it("rejects a signed-out caller before reaching the AI layer", async () => {
    getPrincipal.mockResolvedValue(null);
    const res = await steer({ sessionId: "s1", runId: "r1", text: "hi", mode: "steer" });
    expect(res.status).toBe(401);
    expect(steerChatRun).not.toHaveBeenCalled();
  });

  it.each([
    [{ runId: "r1", text: "hi" }, "missing_ids"],
    [{ sessionId: "s1", text: "hi" }, "missing_ids"],
    [{ sessionId: "s1", runId: "r1", text: "   " }, "empty_message"],
    [{ sessionId: "s1", runId: "r1", text: "hi", mode: "shout" }, "bad_mode"],
  ])("refuses %j with %s", async (body, error) => {
    const res = await steer(body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(error);
    expect(steerChatRun).not.toHaveBeenCalled();
  });

  it.each(["steer", "queue", "interrupt"] as const)(
    "forwards a %s on the request's profile and returns the server's item",
    async (mode) => {
      const item = { run_id: "r1", mode, item_id: "it_1", status: mode === "steer" ? "pending" : "queued" };
      steerChatRun.mockResolvedValue(item);
      const res = await steer({ sessionId: "s1", runId: "r1", text: " look at B ", mode, profile: "work" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(item);
      expect(steerChatRun).toHaveBeenCalledWith("s1", "r1", "look at B", mode);
      expect(apiClientForRequest).toHaveBeenCalledWith({ profile: "work" });
    },
  );

  it("defaults to steer when no mode is given", async () => {
    steerChatRun.mockResolvedValue({ run_id: "r1", mode: "steer", item_id: "i", status: "pending" });
    await steer({ sessionId: "s1", runId: "r1", text: "hi" });
    expect(steerChatRun).toHaveBeenCalledWith("s1", "r1", "hi", "steer");
  });

  it("passes a finished run's 409 through so the client can send a normal turn", async () => {
    steerChatRun.mockRejectedValue(new HermesApiError(409, "run_finished"));
    const res = await steer({ sessionId: "s1", runId: "r1", text: "hi", mode: "steer" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { detail: string }).detail).toBe("run_finished");
  });

  it("keeps the upstream's access refusal (404 for another session's run)", async () => {
    steerChatRun.mockRejectedValue(new HermesApiError(404, "Run not found"));
    const res = await steer({ sessionId: "s1", runId: "r_other", text: "hi" });
    expect(res.status).toBe(404);
  });

  it("answers 502 when the AI layer is unreachable", async () => {
    steerChatRun.mockRejectedValue(new TypeError("fetch failed"));
    const res = await steer({ sessionId: "s1", runId: "r1", text: "hi" });
    expect(res.status).toBe(502);
  });
});

describe("POST /api/chat/queue/remove", () => {
  it("rejects a signed-out caller", async () => {
    getPrincipal.mockResolvedValue(null);
    const res = await remove({ sessionId: "s1", runId: "r1", itemId: "i1" });
    expect(res.status).toBe(401);
    expect(removeQueuedChatInput).not.toHaveBeenCalled();
  });

  it("requires all three ids", async () => {
    const res = await remove({ sessionId: "s1", runId: "r1" });
    expect(res.status).toBe(400);
    expect(removeQueuedChatInput).not.toHaveBeenCalled();
  });

  it.each([true, false])("forwards on the request's profile and reports removed=%s", async (removed) => {
    removeQueuedChatInput.mockResolvedValue({ removed });
    const res = await remove({ sessionId: "s1", runId: "r1", itemId: "i1", profile: "work" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed });
    expect(removeQueuedChatInput).toHaveBeenCalledWith("s1", "r1", "i1");
    expect(apiClientForRequest).toHaveBeenCalledWith({ profile: "work" });
  });
});
