/** BFF tests for the owner/admin Skills and Skills hub routes. */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET as getContent, PUT as putContent } from "@/app/api/skills/content/route";
import { GET as getDetails } from "@/app/api/skills/details/route";
import { POST as install } from "@/app/api/skills/hub/install/route";
import { GET as preview } from "@/app/api/skills/hub/preview/route";
import { GET as scan } from "@/app/api/skills/hub/scan/route";
import { GET as search } from "@/app/api/skills/hub/search/route";
import { GET as sources } from "@/app/api/skills/hub/sources/route";
import { POST as uninstall } from "@/app/api/skills/hub/uninstall/route";
import { GET, POST } from "@/app/api/skills/route";
import { PUT as toggle } from "@/app/api/skills/toggle/route";
import { defaultSkillPermissions, type MySkillPermissions } from "@/lib/skills/permissions";
import type { Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const boundProfiles: Array<string | undefined> = [];
/** Profiles the Skills-permission check was bound to (kept out of `boundProfiles`). */
const permissionProfiles: Array<string | undefined> = [];
// GET /api/access/skills/me: the role's defaults unless a test overrides them.
const mySkillPermissions = vi.fn(async (): Promise<MySkillPermissions> => {
  permissionProfiles.push(boundProfiles.pop());
  const p = await getPrincipal();
  return { role: p?.role ?? "", actions: defaultSkillPermissions(p?.role ?? "", p?.is_owner) };
});
const client = {
  skillList: vi.fn(),
  createSkill: vi.fn(),
  toggleSkill: vi.fn(),
  skillContent: vi.fn(),
  skillDetails: vi.fn(),
  updateSkillContent: vi.fn(),
  skillHubSources: vi.fn(),
  skillHubSearch: vi.fn(),
  skillHubPreview: vi.fn(),
  skillHubScan: vi.fn(),
  installHubSkill: vi.fn(),
  uninstallHubSkill: vi.fn(),
};

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async (opts: { profile?: string } = {}) => {
    boundProfiles.push(opts.profile);
    return { ...client, mySkillPermissions: () => mySkillPermissions() };
  },
}));

const who = (role: Principal["role"]): Principal => ({
  user_id: role,
  display: role,
  role,
  channels: [],
  is_owner: role === "owner",
});
const get = (url: string) => new Request(`http://x${url}`);
const json = (method: string, body: unknown) =>
  new Request("http://x/api/skills", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const CALLS: Array<[string, () => Promise<Response>]> = [
  ["GET /api/skills", () => GET(get("/api/skills"))],
  ["POST /api/skills", () => POST(json("POST", { name: "smoke-s", content: "---\n" }))],
  ["PUT toggle", () => toggle(json("PUT", { name: "a", enabled: false }))],
  ["GET content", () => getContent(get("/api/skills/content?name=a"))],
  ["GET details", () => getDetails(get("/api/skills/details?name=a"))],
  ["PUT content", () => putContent(json("PUT", { name: "a", content: "x" }))],
  ["GET hub sources", () => sources(get("/api/skills/hub/sources"))],
  ["GET hub search", () => search(get("/api/skills/hub/search?q=linear"))],
  ["GET hub preview", () => preview(get("/api/skills/hub/preview?identifier=a"))],
  ["GET hub scan", () => scan(get("/api/skills/hub/scan?identifier=a"))],
  ["POST hub install", () => install(json("POST", { identifier: "a" }))],
  ["POST hub uninstall", () => uninstall(json("POST", { name: "a" }))],
];

describe("Skills BFF routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    boundProfiles.length = 0;
    permissionProfiles.length = 0;
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

  it("follows the caller's Skills permissions, checked in the requested profile", async () => {
    getPrincipal.mockResolvedValue(who("member"));
    mySkillPermissions.mockResolvedValueOnce({
      role: "member",
      actions: { use: true, view: true, agent_edit: false, manage: false, lab: false },
    });
    client.skillList.mockResolvedValue([]);
    expect((await GET(get("/api/skills?profile=coder"))).status).toBe(200);
    // A one-off reply skips the default mock's bookkeeping: both the
    // permission check and the data call are bound to "coder".
    expect(boundProfiles).toEqual(["coder", "coder"]);
    mySkillPermissions.mockResolvedValueOnce({
      role: "member",
      actions: { use: true, view: true, agent_edit: false, manage: false, lab: false },
    });
    const res = await toggle(json("PUT", { name: "a", enabled: false, profile: "coder" }));
    expect(res.status).toBe(403);
    expect((await res.json()).action).toBe("manage");
    expect(client.toggleSkill).not.toHaveBeenCalled();
    // An admin whose role was turned off for this profile is refused too.
    getPrincipal.mockResolvedValue(who("admin"));
    mySkillPermissions.mockResolvedValueOnce({
      role: "admin",
      actions: { use: true, view: false, agent_edit: false, manage: false, lab: false },
    });
    expect((await GET(get("/api/skills"))).status).toBe(403);
  });

  it("fails closed when the permissions can't be read", async () => {
    getPrincipal.mockResolvedValue(who("owner"));
    mySkillPermissions.mockRejectedValueOnce(new Error("socket hang up"));
    expect((await GET(get("/api/skills"))).status).toBe(502);
    expect(client.skillList).not.toHaveBeenCalled();
  });

  it("binds the requested profile for reads and writes", async () => {
    getPrincipal.mockResolvedValue(who("admin"));
    client.skillList.mockResolvedValue([]);
    client.toggleSkill.mockResolvedValue({ ok: true });
    await GET(get("/api/skills?profile=coder"));
    await toggle(json("PUT", { name: "a", enabled: false, profile: "coder" }));
    await GET(get("/api/skills?profile=default"));
    expect(boundProfiles).toEqual(["coder", "coder", undefined]);
    expect(client.toggleSkill).toHaveBeenCalledWith("a", false);
  });

  it("never returns the SKILL.md file path", async () => {
    getPrincipal.mockResolvedValue(who("admin"));
    client.skillContent.mockResolvedValue({ name: "a", content: "---", path: "/opt/x/SKILL.md" });
    const res = await getContent(get("/api/skills/content?name=a"));
    expect(await res.json()).toEqual({ name: "a", content: "---" });
  });

  it("creates a skill with name, category and content", async () => {
    getPrincipal.mockResolvedValue(who("owner"));
    client.createSkill.mockResolvedValue({ success: true, message: "ok", path: "/x" });
    const res = await POST(json("POST", { name: "smoke-s", content: "---\nname: x\n---", category: "demo" }));
    expect(res.status).toBe(200);
    expect(client.createSkill).toHaveBeenCalledWith({ name: "smoke-s", content: "---\nname: x\n---", category: "demo" });
    expect(await res.json()).toEqual({ ok: true, message: "ok" });
  });

  it("validates inputs before proxying", async () => {
    getPrincipal.mockResolvedValue(who("admin"));
    expect((await toggle(json("PUT", { name: "a" }))).status).toBe(400);
    expect((await search(get("/api/skills/hub/search?q="))).status).toBe(400);
    expect((await install(json("POST", {}))).status).toBe(400);
    expect(client.toggleSkill).not.toHaveBeenCalled();
    expect(client.installHubSkill).not.toHaveBeenCalled();
  });

  it("installs into the chosen profile", async () => {
    getPrincipal.mockResolvedValue(who("admin"));
    client.installHubSkill.mockResolvedValue({ ok: true, pid: 12, name: "skills-install" });
    const res = await install(json("POST", { identifier: "official/linear", profile: "coder" }));
    expect(await res.json()).toEqual({ ok: true });
    expect(client.installHubSkill).toHaveBeenCalledWith("official/linear");
    expect(boundProfiles).toEqual(["coder"]);
  });

  it("details: requires a name, binds the profile and forwards only relative file facts", async () => {
    getPrincipal.mockResolvedValue(who("admin"));
    expect((await getDetails(get("/api/skills/details"))).status).toBe(400);
    client.skillDetails.mockResolvedValue({
      name: "a",
      files: [{ path: "SKILL.md", size: 10, abs: "/opt/data/x/SKILL.md" }],
      files_truncated: false,
      modified_at: 1700000000,
      used_by: [{ profile: "coder", enabled: true, path: "/opt/data/profiles/coder" }],
      path: "/opt/data/x",
    });
    const res = await getDetails(get("/api/skills/details?name=a&profile=coder"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      name: "a",
      files: [{ path: "SKILL.md", size: 10 }],
      files_truncated: false,
      modified_at: 1700000000,
      used_by: [{ profile: "coder", enabled: true }],
    });
    expect(JSON.stringify(body)).not.toContain("/opt/data");
    expect(boundProfiles).toEqual(["coder"]);
    expect(client.skillDetails).toHaveBeenCalledWith("a");
  });
});
