/**
 * BFF tests for the project Skills tab routes: principal gate, the `days`
 * window clamped to 30|90, the dismiss pass-through, and upstream refusals
 * (404 unreadable, 403 no lab, 409 archived) passed through.
 */
import { describe, expect, it, vi } from "vitest";

import { HermesApiError } from "@/lib/api/client";

const principalState: { principal: unknown } = { principal: { user_id: "leo" } };
const clientState: { client: unknown } = { client: null };

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: async () => principalState.principal,
  apiClientForRequest: async () => clientState.client,
}));

import { POST as dismiss } from "./candidates/[id]/dismiss/route";
import { GET } from "./route";

const get = (qs = "") => new Request(`http://x/api/projects/digest/skills${qs}`);
const slug = (s: string) => ({ params: Promise.resolve({ slug: s }) });

describe("GET /api/projects/:slug/skills", () => {
  it("answers 401 without a session", async () => {
    principalState.principal = null;
    expect((await GET(get(), slug("digest"))).status).toBe(401);
  });

  it("forwards the window, defaulting anything but 30 to 90", async () => {
    principalState.principal = { user_id: "leo" };
    const calls: Array<[string, number]> = [];
    clientState.client = {
      projectSkills: async (s: string, days: number) => {
        calls.push([s, days]);
        return { window_days: days, skills: [] };
      },
    };
    const res = await GET(get("?days=30"), slug("digest"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ window_days: 30, skills: [] });
    await GET(get("?days=7"), slug("digest"));
    await GET(get(), slug("digest"));
    expect(calls).toEqual([
      ["digest", 30],
      ["digest", 90],
      ["digest", 90],
    ]);
  });

  it("passes an unreadable project's 404 through", async () => {
    principalState.principal = { user_id: "eve" };
    clientState.client = {
      projectSkills: async () => {
        throw new HermesApiError(404, "GET /skills", { detail: "project not found" });
      },
    };
    expect((await GET(get(), slug("secret"))).status).toBe(404);
  });
});

describe("POST /api/projects/:slug/skills/candidates/:id/dismiss", () => {
  const post = () => new Request("http://x/dismiss", { method: "POST", body: "{}" });
  const ids = (s: string, id: string) => ({ params: Promise.resolve({ slug: s, id }) });

  it("answers 401 without a session", async () => {
    principalState.principal = null;
    expect((await dismiss(post(), ids("digest", "skc_1"))).status).toBe(401);
  });

  it("dismisses the candidate upstream", async () => {
    principalState.principal = { user_id: "leo" };
    const calls: string[][] = [];
    clientState.client = {
      dismissProjectSkillCandidate: async (s: string, id: string) => {
        calls.push([s, id]);
        return { ok: true, id, dismissed_at: 1 };
      },
    };
    const res = await dismiss(post(), ids("digest", "skc_1"));
    expect(res.status).toBe(200);
    expect(calls).toEqual([["digest", "skc_1"]]);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  it.each([403, 409])("passes the upstream's %i refusal through", async (status) => {
    principalState.principal = { user_id: "mia" };
    clientState.client = {
      dismissProjectSkillCandidate: async () => {
        throw new HermesApiError(status, "POST /dismiss", { detail: "refused" });
      },
    };
    const res = await dismiss(post(), ids("digest", "skc_1"));
    expect(res.status).toBe(status);
    expect(((await res.json()) as { detail: string }).detail).toBe("refused");
  });
});
