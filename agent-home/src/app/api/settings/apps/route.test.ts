import { beforeEach, describe, expect, it, vi } from "vitest";

import * as github from "@/app/api/settings/apps/github/route";
import * as limits from "@/app/api/settings/apps/limits/route";
import * as storage from "@/app/api/settings/apps/storage/route";
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

function req(body: unknown, method = "PUT"): Request {
  return new Request("http://localhost/api/settings/apps/x", { method, body: JSON.stringify(body) });
}

const writes: Array<[string, () => Promise<Response>]> = [
  ["PUT limits", () => limits.PUT(req({ limits: { member: { per_member: { apps_running: 3 } } } }))],
  ["PUT storage", () => storage.PUT(req({ base_path: "/srv/apps" }))],
  ["PUT github", () => github.PUT(req({ owner: "acme" }))],
  ["DELETE github", () => github.DELETE()],
];
const reads: Array<[string, () => Promise<Response>]> = [
  ["GET limits", () => limits.GET()],
  ["GET storage", () => storage.GET()],
  ["GET github", () => github.GET()],
];

describe("/api/settings/apps/*", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    request.mockResolvedValue({});
  });

  it.each([...writes, ...reads])("%s: 401 signed out, 403 for member/viewer, never reaching Python", async (_, call) => {
    getPrincipal.mockResolvedValue(null);
    expect((await call()).status).toBe(401);
    for (const role of ["member", "viewer"] as const) {
      as(role);
      expect((await call()).status).toBe(403);
    }
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["owner", "admin"] as const)("forwards writes for an %s to the quotas API", async (role) => {
    as(role);
    for (const [, call] of writes) expect((await call()).status).toBe(200);
    expect(request.mock.calls.map(([path, init]) => `${init.method} ${path}`)).toEqual([
      "PUT /api/quotas/defaults",
      "PUT /api/quotas/storage",
      "PUT /api/quotas/github",
      "DELETE /api/quotas/github",
    ]);
  });

  it("rejects malformed bodies before Python", async () => {
    as("owner");
    const bad = [
      limits.PUT(req({ limits: { member: { per_app: { memory_max_mb: -1 } } } })),
      limits.PUT(req({ limits: { root: {} } })),
      limits.PUT(req({ limits: [] })),
      storage.PUT(req({ base_path: "relative/path" })),
      storage.PUT(req({ min_free_mb: 1.5 })),
      storage.PUT(req({})),
      github.PUT(req({ use_box_git: "yes" })),
      github.PUT(req({})),
    ];
    for (const res of await Promise.all(bad)) expect(res.status).toBe(400);
    expect(request).not.toHaveBeenCalled();
  });

  it("never returns more of the GitHub token than its last 4", async () => {
    as("owner");
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    request.mockResolvedValue({
      owner: "acme", use_box_git: false, mode: "token",
      token: { set: true, last4: secret, value: secret }, payload: { token: secret },
    });
    for (const call of [() => github.GET(), () => github.PUT(req({ token: secret }))]) {
      const res = await call();
      const text = await res.text();
      expect(text).not.toContain(secret.slice(0, -4));
      expect(JSON.parse(text).token).toEqual({ set: true, last4: "6789" });
    }
    expect(request).toHaveBeenLastCalledWith("/api/quotas/github", { method: "PUT", json: { token: secret } });
  });

  it("passes the API's refusal through (e.g. an admin editing the admins' tier)", async () => {
    as("admin");
    const { HermesApiError } = await import("@/lib/api/client");
    request.mockRejectedValue(new HermesApiError(403, "Only the owner can change the admins' app limits."));
    const res = await limits.PUT(req({ limits: { admin: { per_member: { apps_running: 9 } } } }));
    expect(res.status).toBe(403);
  });
});
