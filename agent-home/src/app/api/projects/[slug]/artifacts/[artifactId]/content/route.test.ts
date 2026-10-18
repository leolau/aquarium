/**
 * Project-artifact content route: an agent can write any file, so the BFF —
 * not the upstream disposition — decides inline vs download and sandboxes it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/projects/[slug]/artifacts/[artifactId]/content/route";
import type { Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const projectArtifactContent = vi.fn<(...args: unknown[]) => Promise<Response>>();

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async () => ({ projectArtifactContent }),
}));

function upstream(type: string, filename: string, disposition = "inline"): Response {
  return new Response("<script>alert(document.cookie)</script>", {
    status: 200,
    headers: {
      "content-type": type,
      "content-disposition": `${disposition}; filename="${filename}"`,
    },
  });
}

function get(query = ""): Promise<Response> {
  return GET(new Request(`http://home.test/api/projects/mou/artifacts/f1/content${query}`), {
    params: Promise.resolve({ slug: "mou", artifactId: "f1" }),
  }) as unknown as Promise<Response>;
}

describe("GET /api/projects/:slug/artifacts/:artifactId/content", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPrincipal.mockResolvedValue({
      user_id: "leo_owner",
      display: "Leo",
      role: "owner",
      channels: [],
      is_owner: true,
    });
  });

  it("downloads an agent-written HTML file even when upstream says inline", async () => {
    projectArtifactContent.mockResolvedValueOnce(upstream("text/html; charset=utf-8", "report.html"));
    const res = await get();
    expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(res.headers.get("content-disposition")).toContain("report.html");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toMatch(/^sandbox;/);
  });

  it("keeps a PDF inline, sandboxed", async () => {
    projectArtifactContent.mockResolvedValueOnce(upstream("application/pdf", "mou.pdf"));
    const res = await get();
    expect(res.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(res.headers.get("content-security-policy")).toMatch(/^sandbox;/);
  });

  it("downloads on ?download=1", async () => {
    projectArtifactContent.mockResolvedValueOnce(upstream("application/pdf", "mou.pdf"));
    expect((await get("?download=1")).headers.get("content-disposition")).toMatch(/^attachment;/);
  });

  it("401s without a session", async () => {
    getPrincipal.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
    expect(projectArtifactContent).not.toHaveBeenCalled();
  });
});
