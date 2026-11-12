/**
 * BFF tests for the triage skill file routes: view for any signed-in person,
 * save for owner/admin only (Hermes re-checks), bound to `?profile=`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET as HISTORY } from "@/app/api/triage/skill-file/history/route";
import { GET, PUT } from "@/app/api/triage/skill-file/route";
import { HermesApiError } from "@/lib/api/client";
import type { Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const client = {
  triageSkillFile: vi.fn(),
  triageSkillFileHistory: vi.fn(),
  saveTriageSkillFile: vi.fn(),
};
const apiClientForRequest = vi.fn<(opts?: { profile?: string }) => Promise<typeof client>>(async () => client);

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: (opts?: { profile?: string }) => apiClientForRequest(opts),
}));

const who = (role: Principal["role"]): Principal => ({ user_id: role, display: role, role, channels: [], is_owner: role === "owner" });
const FILE = "/opt/data/skills/email-triage/SKILL.md";
const q = `kind=email&path=${encodeURIComponent(FILE)}`;
const put = (body: unknown, query = "?profile=hr") =>
  PUT(new Request(`http://localhost/api/triage/skill-file${query}`, { method: "PUT", body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  getPrincipal.mockResolvedValue(who("member"));
});

describe("GET /api/triage/skill-file", () => {
  it("401s without a principal", async () => {
    getPrincipal.mockResolvedValue(null);
    expect((await GET(new Request(`http://localhost/api/triage/skill-file?${q}`))).status).toBe(401);
    expect(client.triageSkillFile).not.toHaveBeenCalled();
  });

  it("lets a member view, under a client bound to ?profile=", async () => {
    client.triageSkillFile.mockResolvedValue({ kind: "email", name: "SKILL.md", path: FILE, content: "# x", can_edit: false });
    const res = await GET(new Request(`http://localhost/api/triage/skill-file?${q}&profile=hr`));
    expect(res.status).toBe(200);
    expect(client.triageSkillFile).toHaveBeenCalledWith("email", FILE);
    expect(apiClientForRequest).toHaveBeenCalledWith({ profile: "hr" });
  });

  it("needs kind and path", async () => {
    expect((await GET(new Request("http://localhost/api/triage/skill-file?kind=email"))).status).toBe(400);
  });

  it("passes a Hermes 404 (not a triage file) through", async () => {
    client.triageSkillFile.mockRejectedValue(new HermesApiError(404, "not a triage skill file"));
    expect((await GET(new Request(`http://localhost/api/triage/skill-file?${q}`))).status).toBe(404);
  });
});

describe("PUT /api/triage/skill-file", () => {
  it.each(["member", "viewer"] as const)("refuses a %s before calling Hermes", async (role) => {
    getPrincipal.mockResolvedValue(who(role));
    const res = await put({ kind: "email", path: FILE, content: "x" });
    expect(res.status).toBe(403);
    expect(client.saveTriageSkillFile).not.toHaveBeenCalled();
  });

  it.each(["owner", "admin"] as const)("lets an %s save, bound to ?profile=", async (role) => {
    getPrincipal.mockResolvedValue(who(role));
    client.saveTriageSkillFile.mockResolvedValue({ ok: true, path: FILE });
    const res = await put({ kind: "email", path: FILE, content: "# new" });
    expect(res.status).toBe(200);
    expect(client.saveTriageSkillFile).toHaveBeenCalledWith("email", FILE, "# new");
    expect(apiClientForRequest).toHaveBeenCalledWith({ profile: "hr" });
  });

  it("replays Hermes' own role refusal in the addressed profile", async () => {
    getPrincipal.mockResolvedValue(who("owner"));
    client.saveTriageSkillFile.mockRejectedValue(new HermesApiError(403, "Only the owner or an admin can change this setting."));
    expect((await put({ kind: "email", path: FILE, content: "x" })).status).toBe(403);
  });

  it("needs string content", async () => {
    getPrincipal.mockResolvedValue(who("owner"));
    expect((await put({ kind: "email", path: FILE })).status).toBe(400);
  });
});

describe("GET /api/triage/skill-file/history", () => {
  it("forwards under ?profile=", async () => {
    client.triageSkillFileHistory.mockResolvedValue({ kind: "email", path: FILE, versions: [] });
    const res = await HISTORY(new Request(`http://localhost/api/triage/skill-file/history?${q}&profile=hr`));
    expect(res.status).toBe(200);
    expect(client.triageSkillFileHistory).toHaveBeenCalledWith("email", FILE);
    expect(apiClientForRequest).toHaveBeenCalledWith({ profile: "hr" });
  });
});
