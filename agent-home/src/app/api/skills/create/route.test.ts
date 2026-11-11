/** BFF tests for the "New skill with AI" routes (Skills permission: lab). */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST as message } from "@/app/api/skills/create/message/route";
import { POST as save } from "@/app/api/skills/create/save/route";
import { POST as start } from "@/app/api/skills/create/start/route";
import { defaultSkillPermissions, type MySkillPermissions } from "@/lib/skills/permissions";
import type { Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const mySkillPermissions = vi.fn(async (): Promise<MySkillPermissions> => {
  const p = await getPrincipal();
  return { role: p?.role ?? "", actions: defaultSkillPermissions(p?.role ?? "", p?.is_owner) };
});
const client = { request: vi.fn() };
vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async () => ({ ...client, mySkillPermissions: () => mySkillPermissions() }),
}));

const who = (role: Principal["role"]): Principal => ({ user_id: `${role}-1`, display: role, role, channels: [], is_owner: role === "owner" });
const post = (body: unknown) =>
  new Request("http://x/api/skills/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const CALLS: Array<[string, () => Promise<Response>]> = [
  ["start", () => start(post({ goal: "g" }))],
  ["message", () => message(post({ session_id: "s", text: "hi" }))],
  ["save", () => save(post({ name: "a", content: "---\n" }))],
];

describe("Skills create BFF routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(CALLS)("%s: 401 signed out, 403 without lab", async (_l, call) => {
    getPrincipal.mockResolvedValue(null);
    expect((await call()).status).toBe(401);
    getPrincipal.mockResolvedValue(who("viewer"));
    expect((await call()).status).toBe(403);
    expect(client.request).not.toHaveBeenCalled();
  });

  it("forwards only known fields, with the profile", async () => {
    getPrincipal.mockResolvedValue(who("owner"));
    client.request.mockResolvedValueOnce({ session_id: "skillnew_1_abcd1234" });
    const res = await start(post({ profile: "coder", project: "digest", goal: " g ", candidate_id: "c1", card_ids: ["t1", 2], evil: 1 }));
    expect(await res.json()).toEqual({ session_id: "skillnew_1_abcd1234" });
    expect(client.request).toHaveBeenCalledWith("/api/skills/create/start", {
      method: "POST", json: { profile: "coder", project: "digest", goal: "g", candidate_id: "c1", card_ids: ["t1", "2"] },
    });

    client.request.mockResolvedValueOnce({ name: "a", enabled: false });
    await save(post({ profile: "coder", name: "a", content: "---\nname: a\n---\n", project: "digest", session_id: "s", candidate_id: "c1" }));
    expect(client.request).toHaveBeenLastCalledWith("/api/skills/create/save", {
      method: "POST",
      json: { name: "a", content: "---\nname: a\n---\n", profile: "coder", project: "digest", session_id: "s", candidate_id: "c1" },
    });
  });

  it("validates bodies", async () => {
    getPrincipal.mockResolvedValue(who("owner"));
    expect((await message(post({ session_id: "s" }))).status).toBe(400);
    expect((await save(post({ name: "a", content: "  " }))).status).toBe(400);
  });
});
