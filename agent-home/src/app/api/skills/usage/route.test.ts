/** BFF tests for the skill usage routes (owner/admin). */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET as detail } from "@/app/api/skills/usage/detail/route";
import { POST as feedback } from "@/app/api/skills/usage/feedback/route";
import { GET as usage } from "@/app/api/skills/usage/route";
import type { Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const boundProfiles: Array<string | undefined> = [];
const client = { skillUsage: vi.fn(), skillUsageFeedback: vi.fn() };

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
  new Request("http://x/api/skills/usage/feedback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const EVENT = {
  id: 7,
  ts: 1790000000,
  trigger: "skill_view",
  version_id: "v2",
  outcome: "success",
  outcome_source: "user",
  rating: 1,
  note: null,
  session: { id: "s1", title: "Chat" },
  task: null,
  project: null,
  user_id: "yan",
  skill_path: "/opt/data/skills/a/SKILL.md",
};

const CALLS: Array<[string, () => Promise<Response>]> = [
  ["GET usage", () => usage(get("/api/skills/usage"))],
  ["GET detail", () => detail(get("/api/skills/usage/detail?name=a"))],
  ["POST feedback", () => feedback(post({ event_id: 1, rating: 1 }))],
];

describe("Skill usage BFF routes", () => {
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

  it("usage: binds the profile, clamps the window and forwards only row fields", async () => {
    getPrincipal.mockResolvedValue(who("admin"));
    client.skillUsage.mockResolvedValue({
      days: 30,
      skills: [{ name: "a", uses: 3, success_rate: 0.5, last_used_at: 1790000000, trend: [{ day: "2026-11-01", uses: 3 }], path: "/opt/x" }, { uses: 1 }],
    });
    const res = await usage(get("/api/skills/usage?days=30&profile=coder"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skills).toHaveLength(1);
    expect(body.skills[0]).toMatchObject({ name: "a", uses: 3, success: 0, success_rate: 0.5, trend: [{ day: "2026-11-01", uses: 3 }] });
    expect(JSON.stringify(body)).not.toContain("/opt");
    expect(client.skillUsage).toHaveBeenCalledWith(30);
    expect(boundProfiles).toEqual(["coder"]);

    await usage(get("/api/skills/usage?days=9999"));
    expect(client.skillUsage).toHaveBeenLastCalledWith(90);
  });

  it("feedback: validates, trims the note and binds the profile from the body", async () => {
    getPrincipal.mockResolvedValue(who("admin"));
    for (const bad of [{ rating: 1 }, { event_id: "7", rating: 1 }, { event_id: 7, rating: 0 }, { event_id: 7, rating: -1, note: 3 }]) {
      expect((await feedback(post(bad))).status).toBe(400);
    }
    expect(client.skillUsageFeedback).not.toHaveBeenCalled();

    client.skillUsageFeedback.mockResolvedValue({ ...EVENT, rating: -1, outcome: "failure", note: "missed it" });
    const res = await feedback(post({ event_id: 7, rating: -1, note: "  missed it  ", profile: "coder" }));
    expect(res.status).toBe(200);
    expect(client.skillUsageFeedback).toHaveBeenCalledWith({ event_id: 7, rating: -1, note: "missed it" });
    expect(boundProfiles).toEqual(["coder"]);
    const body = await res.json();
    expect(body).toMatchObject({ id: 7, rating: -1, outcome: "failure", note: "missed it" });
    expect(body).not.toHaveProperty("skill_path");

    await feedback(post({ event_id: 7, rating: 1, note: "   " }));
    expect(client.skillUsageFeedback).toHaveBeenLastCalledWith({ event_id: 7, rating: 1 });
  });
});
