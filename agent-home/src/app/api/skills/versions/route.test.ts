/** BFF tests for the skill version routes (Skills Lab C-2). */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST as activate } from "@/app/api/skills/versions/activate/route";
import { GET as detail } from "@/app/api/skills/versions/detail/route";
import { GET as diff } from "@/app/api/skills/versions/diff/route";
import { POST as draft } from "@/app/api/skills/versions/draft/route";
import { GET as list } from "@/app/api/skills/versions/route";
import type { Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const boundProfiles: Array<string | undefined> = [];
const client = {
  request: vi.fn(),
  skillVersionDetail: vi.fn(),
  skillVersionDiff: vi.fn(),
  activateSkillVersion: vi.fn(),
};

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async (opts: { profile?: string } = {}) => {
    boundProfiles.push(opts.profile);
    return client;
  },
}));

const who = (role: Principal["role"]): Principal => ({ user_id: role, display: role, role, channels: [], is_owner: role === "owner" });
const get = (url: string) => new Request(`http://x${url}`);
const post = (body: unknown) =>
  new Request("http://x/api/skills/versions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const META = {
  id: "v2",
  n: 2,
  created_at: 1790000000,
  author: "user:leo",
  message: "Add tax line",
  parent: "v1",
  status: "active",
  source: "edit",
  sha256: "abc",
  trial_of: null,
  path: "/opt/data/hermes-home/skills/.versions/a/v2",
};

const CALLS: Array<[string, () => Promise<Response>]> = [
  ["GET versions", () => list(get("/api/skills/versions?name=a"))],
  ["GET detail", () => detail(get("/api/skills/versions/detail?name=a&id=v1"))],
  ["GET diff", () => diff(get("/api/skills/versions/diff?name=a&a=v1&b=v2"))],
  ["POST draft", () => draft(post({ name: "a", content: "---\n", message: "m" }))],
  ["POST activate", () => activate(post({ name: "a", id: "v1" }))],
];

describe("Skill version BFF routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    boundProfiles.length = 0;
  });

  it.each(CALLS)("%s: 401 when signed out", async (_label, call) => {
    getPrincipal.mockResolvedValue(null);
    expect((await call()).status).toBe(401);
  });

  it.each(CALLS.flatMap(([label, call]) => (["member", "viewer"] as const).map((r) => [label, r, call] as const)))(
    "%s: 403 for %s, never proxied",
    async (_label, role, call) => {
      getPrincipal.mockResolvedValue(who(role));
      expect((await call()).status).toBe(403);
      for (const fn of Object.values(client)) expect(fn).not.toHaveBeenCalled();
    },
  );

  it("validates inputs before proxying", async () => {
    getPrincipal.mockResolvedValue(who("admin"));
    expect((await list(get("/api/skills/versions"))).status).toBe(400);
    expect((await detail(get("/api/skills/versions/detail?name=a"))).status).toBe(400);
    expect((await diff(get("/api/skills/versions/diff?name=a&a=v1"))).status).toBe(400);
    expect((await draft(post({ name: "a", content: "  " }))).status).toBe(400);
    expect((await activate(post({ name: "a" }))).status).toBe(400);
    expect((await activate(post({ name: "a", id: "v1", trial: "yes" }))).status).toBe(400);
    for (const fn of Object.values(client)) expect(fn).not.toHaveBeenCalled();
  });

  it("lists versions for the bound profile without upstream extras", async () => {
    getPrincipal.mockResolvedValue(who("admin"));
    const meta = { ...META } as Partial<typeof META>;
    delete meta.path;
    client.request.mockResolvedValue({ name: "a", active: "v2", versions: [meta], root: "/opt/x" });
    const res = await list(get("/api/skills/versions?name=a&profile=coder"));
    const body = await res.json();
    expect(client.request).toHaveBeenCalledWith("/api/skills/versions?name=a");
    expect(boundProfiles).toEqual(["coder"]);
    expect(body.active).toBe("v2");
    expect(body.versions).toEqual([meta]);
    expect(JSON.stringify(body)).not.toMatch(/\/opt\//);
  });

  it("detail and diff forward content, relative files and the diff text", async () => {
    getPrincipal.mockResolvedValue(who("owner"));
    client.skillVersionDetail.mockResolvedValue({ meta: META, content: "# hi", files: [{ path: "SKILL.md", size: 4, abs: "/x" }] });
    const d = await (await detail(get("/api/skills/versions/detail?name=a&id=v2"))).json();
    expect(client.skillVersionDetail).toHaveBeenCalledWith("a", "v2");
    expect(d.content).toBe("# hi");
    expect(d.files).toEqual([{ path: "SKILL.md", size: 4 }]);
    expect(JSON.stringify(d)).not.toMatch(/\/opt\/|"\/x"/);
    client.skillVersionDiff.mockResolvedValue({ a: "v1", b: "v2", diff: "@@ -1 +1 @@\n-a\n+b\n" });
    const f = await (await diff(get("/api/skills/versions/diff?name=a&a=v1&b=v2"))).json();
    expect(client.skillVersionDiff).toHaveBeenCalledWith("a", "v1", "v2");
    expect(f).toEqual({ a: "v1", b: "v2", diff: "@@ -1 +1 @@\n-a\n+b\n" });
  });

  it("saves a draft and activates (trial defaults to false) in the body's profile", async () => {
    getPrincipal.mockResolvedValue(who("admin"));
    client.request.mockResolvedValue({ ...META, id: "v3", n: 3, status: "draft" });
    const saved = await (await draft(post({ name: "a", content: "---\nname: a\n---\n", message: " try ", profile: "coder" }))).json();
    expect(client.request).toHaveBeenCalledWith("/api/skills/versions/draft", {
      method: "POST",
      json: { name: "a", content: "---\nname: a\n---\n", message: "try" },
    });
    expect(saved.id).toBe("v3");
    expect(saved.status).toBe("draft");
    client.activateSkillVersion.mockResolvedValue({ active: "v1", versions: [META] });
    const res = await (await activate(post({ name: "a", id: "v1" }))).json();
    expect(client.activateSkillVersion).toHaveBeenCalledWith({ name: "a", id: "v1", trial: false });
    expect(res.active).toBe("v1");
    await activate(post({ name: "a", id: "v3", trial: true }));
    expect(client.activateSkillVersion).toHaveBeenLastCalledWith({ name: "a", id: "v3", trial: true });
    expect(boundProfiles).toEqual(["coder", undefined, undefined]);
  });
});
