/** BFF route: the assignable-profiles read is gated and passed through. */
import { describe, expect, it, vi } from "vitest";

const principalState: { principal: unknown } = { principal: { user_id: "leo" } };
const clientState: { client: unknown } = { client: null };

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: async () => principalState.principal,
  apiClientForRequest: async () => clientState.client,
}));

import { GET } from "./route";

const params = { params: Promise.resolve({ slug: "digest" }) };

describe("GET /api/projects/:slug/assignable-profiles", () => {
  it("answers 401 without a session", async () => {
    principalState.principal = null;
    const res = await GET(new Request("http://x"), params);
    expect(res.status).toBe(401);
  });

  it("returns the upstream roster for the slug", async () => {
    principalState.principal = { user_id: "leo" };
    const seen: string[] = [];
    clientState.client = {
      projectAssignableProfiles: async (slug: string) => {
        seen.push(slug);
        return { profiles: [{ name: "writer", in_project: true, is_host: true }] };
      },
    };
    const res = await GET(new Request("http://x"), params);
    expect(res.status).toBe(200);
    expect(seen).toEqual(["digest"]);
    const body = (await res.json()) as { profiles: { name: string }[] };
    expect(body.profiles.map((p) => p.name)).toEqual(["writer"]);
  });
});
