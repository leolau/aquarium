/**
 * BFF route tests for GET /api/models/pinned — kanban cards pinned to a
 * model via `model_override`. Contract: one upstream call (the Python side
 * applies the read gate and the live-status filter), its rows pass through,
 * and upstream failures keep their status.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/models/pinned/route";
import { HermesApiError } from "@/lib/api/client";
import type { Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const projectsPinnedModels = vi.fn();
const projects = vi.fn();
const projectBoard = vi.fn();

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async () => ({ projectsPinnedModels, projects, projectBoard }),
}));

function get(): Promise<Response> {
  return GET(
    new Request("http://home.test/api/models/pinned"),
  ) as unknown as Promise<Response>;
}

describe("GET /api/models/pinned", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPrincipal.mockResolvedValue({
      user_id: "leo",
      display: "Leo",
      role: "owner",
      channels: [],
      is_owner: true,
    });
    projectsPinnedModels.mockResolvedValue({ pinned: [] });
  });

  it("returns 401 when unauthenticated", async () => {
    getPrincipal.mockResolvedValue(null);
    const res = await get();
    expect(res.status).toBe(401);
    expect(projectsPinnedModels).not.toHaveBeenCalled();
  });

  it("passes the upstream rows through in one call, with no board fan-out", async () => {
    const row = {
      project_slug: "canva-deck",
      project_name: "Canva deck",
      task_id: "t1",
      title: "Generate slide 118",
      model: "deepseek-chat",
      status: "running",
    };
    projectsPinnedModels.mockResolvedValue({ pinned: [row] });
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pinned: [row] });
    expect(projectsPinnedModels).toHaveBeenCalledTimes(1);
    expect(projects).not.toHaveBeenCalled();
    expect(projectBoard).not.toHaveBeenCalled();
  });

  it("keeps an upstream error status", async () => {
    projectsPinnedModels.mockRejectedValue(new HermesApiError(503, "busy"));
    const res = await get();
    expect(res.status).toBe(503);
  });

  it("returns 502 when the AI layer is unreachable", async () => {
    projectsPinnedModels.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await get();
    expect(res.status).toBe(502);
  });
});
