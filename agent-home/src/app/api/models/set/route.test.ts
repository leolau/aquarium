/**
 * BFF route tests for POST /api/models/set — forwards a scope/provider/model
 * assignment to the Python API and replays the `confirm_required` /
 * `stale_aux` responses verbatim for the picker to render.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/models/set/route";
import type { ModelSetResponse, Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const setModelAssignment = vi.fn(
  async (): Promise<ModelSetResponse> => ({ ok: true }),
);

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async () => ({ setModelAssignment }),
}));

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://home.test/api/models/set", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  ) as unknown as Promise<Response>;
}

describe("POST /api/models/set", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPrincipal.mockResolvedValue({
      user_id: "leo",
      display: "Leo",
      role: "owner",
      channels: [],
      is_owner: true,
    });
    setModelAssignment.mockResolvedValue({ ok: true });
  });

  it("returns 401 when unauthenticated", async () => {
    getPrincipal.mockResolvedValue(null);
    const res = await post({ scope: "main", provider: "alibaba", model: "glm-5.2" });
    expect(res.status).toBe(401);
  });

  it("returns 403 for a member and changes nothing", async () => {
    getPrincipal.mockResolvedValue({
      user_id: "mia",
      display: "Mia",
      role: "member",
      channels: [],
      is_owner: false,
    });
    const res = await post({ scope: "main", provider: "alibaba", model: "glm-5.2" });
    expect(res.status).toBe(403);
    expect(setModelAssignment).not.toHaveBeenCalled();
  });

  it("lets an admin change the model", async () => {
    getPrincipal.mockResolvedValue({
      user_id: "mia",
      display: "Mia",
      role: "admin",
      channels: [],
      is_owner: false,
    });
    const res = await post({ scope: "main", provider: "alibaba", model: "glm-5.2" });
    expect(res.status).toBe(200);
  });

  it("returns 400 on a missing/unknown scope", async () => {
    for (const body of [
      { provider: "alibaba", model: "glm-5.2" },
      { scope: "sidekick", provider: "alibaba", model: "glm-5.2" },
    ]) {
      const res = await post(body);
      expect(res.status).toBe(400);
    }
    expect(setModelAssignment).not.toHaveBeenCalled();
  });

  it("forwards a main assignment", async () => {
    const res = await post({ scope: "main", provider: "alibaba", model: "glm-5.2" });
    expect(res.status).toBe(200);
    expect(setModelAssignment).toHaveBeenCalledWith({
      scope: "main",
      provider: "alibaba",
      model: "glm-5.2",
      task: undefined,
      base_url: undefined,
      confirm_expensive_model: false,
    });
  });

  it("forwards an auxiliary reset (provider=auto, empty model)", async () => {
    const res = await post({
      scope: "auxiliary",
      task: "vision",
      provider: "auto",
      model: "",
    });
    expect(res.status).toBe(200);
    expect(setModelAssignment).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "auxiliary", task: "vision", provider: "auto" }),
    );
  });

  it("replays confirm_required as a 200 for the picker to confirm", async () => {
    setModelAssignment.mockResolvedValue({
      ok: false,
      confirm_required: true,
      confirm_message: "gpt-5 may be expensive",
    });
    const res = await post({ scope: "main", provider: "openai", model: "gpt-5" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.confirm_required).toBe(true);
    expect(data.confirm_message).toContain("expensive");
  });

  it("replays stale_aux so the UI can warn about orphaned role pins", async () => {
    setModelAssignment.mockResolvedValue({
      ok: true,
      stale_aux: [{ task: "vision", provider: "openai", model: "gpt-5" }],
    });
    const res = await post({ scope: "main", provider: "alibaba", model: "glm-5.2" });
    const data = await res.json();
    expect(data.stale_aux).toHaveLength(1);
    expect(data.stale_aux[0].task).toBe("vision");
  });
});
