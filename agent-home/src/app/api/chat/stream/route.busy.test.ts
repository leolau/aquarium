/**
 * A normal send while a turn is already live on the session: the upstream
 * answers 409 `turn_in_progress` with the live run's id, and the BFF keeps
 * that id so the browser can follow and steer the run instead of failing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/chat/stream/route";
import { HermesApiError } from "@/lib/api/client";
import type { Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const openChatStream = vi.fn();

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async () => ({ openChatStream }),
}));

const post = () =>
  POST(
    new Request("http://home.test/api/chat/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "s1", message: "hi" }),
    }),
  ) as unknown as Promise<Response>;

beforeEach(() => {
  vi.clearAllMocks();
  getPrincipal.mockResolvedValue({
    user_id: "mia_member",
    display: "Mia",
    role: "member",
    channels: [],
    is_owner: false,
  });
});

describe("POST /api/chat/stream on a busy session", () => {
  it.each([
    ["top level", { detail: "turn_in_progress", run_id: "run_live" }],
    ["FastAPI-nested", { detail: { detail: "turn_in_progress", run_id: "run_live" } }],
  ])("returns 409 with the live run id (%s body)", async (_label, body) => {
    openChatStream.mockRejectedValue(
      new HermesApiError(409, "turn_in_progress", JSON.stringify(body)),
    );
    const res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ detail: "turn_in_progress", runId: "run_live" });
  });

  it("leaves any other 409 as a plain api_error", async () => {
    openChatStream.mockRejectedValue(new HermesApiError(409, "conflict", '{"detail":"conflict"}'));
    const res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "api_error", detail: "conflict" });
  });
});
