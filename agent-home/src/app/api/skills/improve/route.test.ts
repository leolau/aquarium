/** BFF tests for the Skills Lab Improve tab routes (improve chats, versions, run detail). */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST as message } from "@/app/api/skills/improve/message/route";
import { GET as sessions } from "@/app/api/skills/improve/sessions/route";
import { POST as start } from "@/app/api/skills/improve/start/route";
import { GET as detail } from "@/app/api/skills/usage/detail/route";
import { POST as draft } from "@/app/api/skills/versions/draft/route";
import { GET as versions } from "@/app/api/skills/versions/route";
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
const client = { request: vi.fn() };

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async (opts: { profile?: string } = {}) => {
    boundProfiles.push(opts.profile);
    return { ...client, mySkillPermissions: () => mySkillPermissions() };
  },
}));

const who = (role: Principal["role"]): Principal => ({ user_id: `${role}-1`, display: role, role, channels: [], is_owner: role === "owner" });
const get = (url: string) => new Request(`http://x${url}`);
const post = (body: unknown) =>
  new Request("http://x/api/skills/improve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const CALLS: Array<[string, () => Promise<Response>]> = [
  ["POST improve/start", () => start(post({ name: "a" }))],
  ["POST improve/message", () => message(post({ session_id: "s1", text: "hi" }))],
  ["GET improve/sessions", () => sessions(get("/api/skills/improve/sessions?name=a"))],
  ["GET versions", () => versions(get("/api/skills/versions?name=a"))],
  ["POST versions/draft", () => draft(post({ name: "a", content: "---\n" }))],
  ["GET usage/detail", () => detail(get("/api/skills/usage/detail?name=a"))],
];

describe("Skills Improve BFF routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    boundProfiles.length = 0;
    permissionProfiles.length = 0;
  });

  it.each(CALLS)("%s: 401 when signed out", async (_label, call) => {
    getPrincipal.mockResolvedValue(null);
    expect((await call()).status).toBe(401);
    expect(client.request).not.toHaveBeenCalled();
  });

  it.each(CALLS.flatMap(([label, call]) => (["member", "viewer"] as const).map((r) => [label, r, call] as const)))(
    "%s: 403 for %s, never proxied",
    async (_label, role, call) => {
      getPrincipal.mockResolvedValue(who(role));
      expect((await call()).status).toBe(403);
      expect(client.request).not.toHaveBeenCalled();
    },
  );

  it("validates inputs before proxying", async () => {
    getPrincipal.mockResolvedValue(who("admin"));
    expect((await start(post({}))).status).toBe(400);
    expect((await message(post({ session_id: "s1" }))).status).toBe(400);
    expect((await message(post({ text: "hi" }))).status).toBe(400);
    expect((await sessions(get("/api/skills/improve/sessions"))).status).toBe(400);
    expect((await versions(get("/api/skills/versions"))).status).toBe(400);
    expect((await draft(post({ name: "a", content: "  " }))).status).toBe(400);
    expect((await detail(get("/api/skills/usage/detail"))).status).toBe(400);
    expect(client.request).not.toHaveBeenCalled();
  });

  it("starts an improve chat with an optional goal in the chosen profile", async () => {
    getPrincipal.mockResolvedValue(who("owner"));
    client.request.mockResolvedValue({ session_id: "imp-1", extra: "dropped" });
    const res = await start(post({ name: "quotation-builder", goal: "fix currency", profile: "coder" }));
    expect(await res.json()).toEqual({ session_id: "imp-1" });
    expect(client.request).toHaveBeenCalledWith("/api/skills/improve/start", { method: "POST", json: { name: "quotation-builder", goal: "fix currency" } });
    await start(post({ name: "quotation-builder" }));
    expect(client.request).toHaveBeenLastCalledWith("/api/skills/improve/start", { method: "POST", json: { name: "quotation-builder" } });
    expect(boundProfiles).toEqual(["coder", undefined]);
  });

  it("returns the reply and a draft only when one was proposed", async () => {
    getPrincipal.mockResolvedValue(who("admin"));
    client.request.mockResolvedValueOnce({ reply: "Here it is", draft: "---\nname: a\n---" });
    expect(await (await message(post({ session_id: "imp-1", text: "go" }))).json()).toEqual({ reply: "Here it is", draft: "---\nname: a\n---" });
    client.request.mockResolvedValueOnce({ reply: "Thinking about it", draft: null });
    expect(await (await message(post({ session_id: "imp-1", text: "go" }))).json()).toEqual({ reply: "Thinking about it" });
    expect(client.request).toHaveBeenCalledWith("/api/skills/improve/message", { method: "POST", json: { session_id: "imp-1", text: "go" } });
  });

  it("lists past improve chats in the shared shape", async () => {
    getPrincipal.mockResolvedValue(who("admin"));
    client.request.mockResolvedValue([{ session_id: "imp-1", title: "Currency", started_at: 1790000000, drafts: 2, path: "/opt/x" }]);
    const res = await sessions(get("/api/skills/improve/sessions?name=a%20b&profile=coder"));
    const body = await res.json();
    expect(body).toEqual([{ session_id: "imp-1", title: "Currency", started_at: 1790000000, drafts: 2 }]);
    expect(client.request).toHaveBeenCalledWith("/api/skills/improve/sessions?name=a%20b");
    expect(boundProfiles).toEqual(["coder"]);
  });

  it("saves a draft credited to the improve chat; plain drafts carry no agent author", async () => {
    getPrincipal.mockResolvedValue(who("admin"));
    client.request.mockResolvedValue({ id: "v5", n: 5, status: "draft" });
    const res = await draft(post({ name: "a", content: "new", message: "Currency", session_id: "imp-1", profile: "coder" }));
    expect(await res.json()).toEqual({ id: "v5", n: 5, status: "draft" });
    expect(client.request).toHaveBeenCalledWith("/api/skills/versions/draft", {
      method: "POST",
      json: { name: "a", content: "new", message: "Currency", session_id: "imp-1", author: "agent:imp-1", source: "improve" },
    });
    await draft(post({ name: "a", content: "new" }));
    expect(client.request).toHaveBeenLastCalledWith("/api/skills/versions/draft", { method: "POST", json: { name: "a", content: "new", message: "" } });
    expect(boundProfiles).toEqual(["coder", undefined]);
  });

  it("reads versions and run detail, forwarding only known query params", async () => {
    getPrincipal.mockResolvedValue(who("admin"));
    client.request.mockResolvedValueOnce({ name: "a", active: "v4", versions: [{ id: "v4", n: 4 }] });
    expect(await (await versions(get("/api/skills/versions?name=a&profile=coder"))).json()).toEqual({ name: "a", active: "v4", versions: [{ id: "v4", n: 4 }] });
    client.request.mockResolvedValueOnce({ name: "a", events: [], next_cursor: null });
    await detail(get("/api/skills/usage/detail?name=a&days=30&limit=abc&cursor=c2&evil=1"));
    expect(client.request).toHaveBeenLastCalledWith("/api/skills/usage/detail?name=a&days=30&cursor=c2");
    expect(boundProfiles).toEqual(["coder", undefined]);
  });
});
