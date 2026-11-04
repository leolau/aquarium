/**
 * BFF tests for the owner/admin Profiles routes: members and viewers get 403
 * before anything reaches Python, admins are proxied, paths never leak.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DELETE as deleteProfile, PATCH as renameProfile } from "@/app/api/profiles/named/[name]/route";
import { POST as describeAuto } from "@/app/api/profiles/named/[name]/describe-auto/route";
import { PUT as putDescription } from "@/app/api/profiles/named/[name]/description/route";
import { PUT as putModel } from "@/app/api/profiles/named/[name]/model/route";
import { GET as getSoul, PUT as putSoul } from "@/app/api/profiles/named/[name]/soul/route";
import { GET, POST } from "@/app/api/profiles/route";
import { HermesApiError } from "@/lib/api/client";
import type { Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const client = {
  profileInfos: vi.fn(),
  createProfile: vi.fn(),
  renameProfile: vi.fn(),
  deleteProfile: vi.fn(),
  profileSoul: vi.fn(),
  setProfileSoul: vi.fn(),
  setProfileDescription: vi.fn(),
  describeProfileAuto: vi.fn(),
  setProfileModel: vi.fn(),
};

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async () => client,
}));

const who = (role: Principal["role"]): Principal => ({
  user_id: role,
  display: role,
  role,
  channels: [],
  is_owner: role === "owner",
});

const json = (method: string, body: unknown) =>
  new Request("http://x/api/profiles", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const ctx = (name: string) => ({ params: Promise.resolve({ name }) });

const CALLS: Array<[string, () => Promise<Response>]> = [
  ["GET /api/profiles", () => GET()],
  ["POST /api/profiles", () => POST(json("POST", { name: "smoke-x" }))],
  ["PATCH named", () => renameProfile(json("PATCH", { new_name: "y" }), ctx("x"))],
  ["DELETE named", () => deleteProfile(new Request("http://x", { method: "DELETE" }), ctx("x"))],
  ["GET soul", () => getSoul(new Request("http://x"), ctx("x"))],
  ["PUT soul", () => putSoul(json("PUT", { content: "hi" }), ctx("x"))],
  ["PUT description", () => putDescription(json("PUT", { description: "d" }), ctx("x"))],
  ["POST describe-auto", () => describeAuto(json("POST", {}), ctx("x"))],
  ["PUT model", () => putModel(json("PUT", { provider: "p", model: "m" }), ctx("x"))],
];

describe("Profiles BFF routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(CALLS)("%s: 401 when signed out", async (_label, call) => {
    getPrincipal.mockResolvedValue(null);
    expect((await call()).status).toBe(401);
  });

  it.each(CALLS.flatMap(([label, call]) => (["member", "viewer"] as const).map((r) => [label, r, call] as const)))(
    "%s: 403 for %s, never proxied",
    async (_label, role, call) => {
      getPrincipal.mockResolvedValue(who(role));
      const res = await call();
      expect(res.status).toBe(403);
      for (const fn of Object.values(client)) expect(fn).not.toHaveBeenCalled();
    },
  );

  it("lists profiles for an admin without filesystem paths", async () => {
    getPrincipal.mockResolvedValue(who("admin"));
    client.profileInfos.mockResolvedValue({
      profiles: [
        {
          name: "default",
          path: "/opt/data/hermes-home",
          is_default: true,
          model: "m",
          provider: "p",
          skill_count: 3,
          gateway_running: true,
          description: "d",
          description_auto: true,
          has_env: true,
        },
      ],
    });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("/opt/data");
    expect(body.profiles[0]).toMatchObject({ name: "default", skill_count: 3, description_auto: true });
  });

  it("creates with one POST carrying the builder answers, path stripped", async () => {
    getPrincipal.mockResolvedValue(who("owner"));
    client.createProfile.mockResolvedValue({
      ok: true,
      name: "smoke-x",
      path: "/secret",
      model_set: true,
      skills_disabled: 2,
      hub_installs: [],
    });
    const res = await POST(
      json("POST", {
        name: "smoke-x",
        clone_from: "default",
        provider: "p",
        model: "m",
        keep_skills: ["a"],
        hub_skills: ["official/x"],
      }),
    );
    expect(res.status).toBe(200);
    expect(client.createProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "smoke-x",
        clone_from: "default",
        clone_all: false,
        provider: "p",
        model: "m",
        keep_skills: ["a"],
        hub_skills: ["official/x"],
      }),
    );
    expect(JSON.stringify(await res.json())).not.toContain("/secret");
  });

  it("rejects a create without a name", async () => {
    getPrincipal.mockResolvedValue(who("admin"));
    expect((await POST(json("POST", { name: " " }))).status).toBe(400);
    expect(client.createProfile).not.toHaveBeenCalled();
  });

  it("replays the Python refusal (e.g. deleting the default profile)", async () => {
    getPrincipal.mockResolvedValue(who("admin"));
    client.deleteProfile.mockRejectedValue(new HermesApiError(400, "Cannot delete the default profile", null));
    const res = await deleteProfile(new Request("http://x", { method: "DELETE" }), ctx("default"));
    expect(res.status).toBe(400);
    expect((await res.json()).detail).toMatch(/default/);
  });

  it("returns only the SOUL.md content", async () => {
    getPrincipal.mockResolvedValue(who("admin"));
    client.profileSoul.mockResolvedValue({ content: "be kind", path: "/x/SOUL.md" });
    const res = await getSoul(new Request("http://x"), ctx("coder"));
    expect(await res.json()).toEqual({ content: "be kind" });
    expect(client.profileSoul).toHaveBeenCalledWith("coder");
  });
});
