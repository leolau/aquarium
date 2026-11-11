/** BFF tests for Settings → Skills permissions (`/api/access/skills`). */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PUT } from "@/app/api/access/skills/[role]/route";
import { GET as me } from "@/app/api/access/skills/me/route";
import { GET } from "@/app/api/access/skills/route";
import { HermesApiError } from "@/lib/api/client";
import type { Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const boundProfiles: Array<string | undefined> = [];
const client = { skillPermissions: vi.fn(), setSkillPermissions: vi.fn(), mySkillPermissions: vi.fn() };
const revalidateTag = vi.fn();

vi.mock("next/cache", () => ({ revalidateTag: (tag: string) => revalidateTag(tag), unstable_cache: (fn: unknown) => fn }));
vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async (opts: { profile?: string } = {}) => {
    boundProfiles.push(opts.profile);
    return client;
  },
}));

const who = (role: Principal["role"]): Principal => ({ user_id: role, display: role, role, channels: [], is_owner: role === "owner" });
const put = (role: string, body: unknown) =>
  PUT(
    new Request(`http://x/api/access/skills/${role}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ role }) },
  );
const STATE = { actions: [], roles: [] };

describe("Skills permissions BFF routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    boundProfiles.length = 0;
  });

  it("GET: owner and admin only", async () => {
    getPrincipal.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    for (const role of ["member", "viewer"] as const) {
      getPrincipal.mockResolvedValue(who(role));
      expect((await GET()).status).toBe(403);
    }
    expect(client.skillPermissions).not.toHaveBeenCalled();
    getPrincipal.mockResolvedValue(who("admin"));
    client.skillPermissions.mockResolvedValue(STATE);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(STATE);
  });

  it("PUT: refuses members, the owner column and unknown roles before proxying", async () => {
    getPrincipal.mockResolvedValue(who("member"));
    expect((await put("viewer", { actions: { view: true } })).status).toBe(403);
    getPrincipal.mockResolvedValue(who("owner"));
    expect((await put("owner", { actions: { view: false } })).status).toBe(400);
    expect((await put("guest", { actions: { view: false } })).status).toBe(400);
    expect(client.setSkillPermissions).not.toHaveBeenCalled();
  });

  it("PUT: only the owner may change the admin column", async () => {
    getPrincipal.mockResolvedValue(who("admin"));
    const res = await put("admin", { actions: { lab: false } });
    expect(res.status).toBe(403);
    expect((await res.json()).detail).toBe("Only the owner can change what admins can do.");
    getPrincipal.mockResolvedValue(who("owner"));
    client.setSkillPermissions.mockResolvedValue(STATE);
    expect((await put("admin", { actions: { lab: false } })).status).toBe(200);
    expect(client.setSkillPermissions).toHaveBeenCalledWith("admin", { actions: { lab: false } });
  });

  it("PUT: admins change members and viewers; reset and bad bodies", async () => {
    getPrincipal.mockResolvedValue(who("admin"));
    client.setSkillPermissions.mockResolvedValue(STATE);
    expect((await put("member", { actions: { manage: true } })).status).toBe(200);
    expect((await put("viewer", { reset: true })).status).toBe(200);
    expect(client.setSkillPermissions.mock.calls).toEqual([
      ["member", { actions: { manage: true } }],
      ["viewer", { reset: true }],
    ]);
    expect(revalidateTag).toHaveBeenCalledWith("agent-home-skills-permissions");
    for (const body of [{}, { actions: {} }, { actions: { fly: true } }, { actions: { view: "yes" } }, { actions: [true] }]) {
      expect((await put("member", body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(client.setSkillPermissions).toHaveBeenCalledTimes(2);
  });

  it("PUT: replays the server's refusal", async () => {
    getPrincipal.mockResolvedValue(who("admin"));
    client.setSkillPermissions.mockRejectedValue(new HermesApiError(403, "Only the owner can change what admins can do."));
    const res = await put("member", { actions: { view: true } });
    expect(res.status).toBe(403);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("me: any signed-in caller, bound to ?profile=, with role defaults when the API predates it", async () => {
    getPrincipal.mockResolvedValue(null);
    expect((await me(new Request("http://x/api/access/skills/me"))).status).toBe(401);
    getPrincipal.mockResolvedValue(who("viewer"));
    const actions = { use: true, view: true, agent_edit: false, manage: false, lab: false };
    client.mySkillPermissions.mockResolvedValue({ role: "viewer", actions });
    const res = await me(new Request("http://x/api/access/skills/me?profile=coder"));
    expect(await res.json()).toEqual({ role: "viewer", actions });
    expect(boundProfiles).toEqual(["coder"]);
    client.mySkillPermissions.mockRejectedValue(new HermesApiError(404, "Not Found"));
    expect(await (await me(new Request("http://x/api/access/skills/me"))).json()).toEqual({
      role: "viewer",
      actions: { use: true, view: false, agent_edit: false, manage: false, lab: false },
    });
    getPrincipal.mockResolvedValue(who("owner"));
    expect((await (await me(new Request("http://x/api/access/skills/me"))).json()).actions.lab).toBe(true);
    client.mySkillPermissions.mockRejectedValue(new HermesApiError(500, "boom"));
    expect((await me(new Request("http://x/api/access/skills/me"))).status).toBe(500);
  });
});
