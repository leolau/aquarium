/**
 * BFF route tests for GET /api/chat/sessions.
 *
 * Regression guard: a missing or garbage `limit` param must become
 * `undefined` upstream — `Number(null)` is 0, and clamping that to 1 made
 * every client-side refresh collapse the conversation list to the single
 * most-recent session.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/chat/sessions/route";
import type { Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const sessions = vi.fn(async () => ({ sessions: [] }));
const allSessions = vi.fn(async () => ({ sessions: [] }));

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async () => ({ sessions, allSessions }),
}));

const principal: Principal = {
  user_id: "mia",
  display: "Mia",
  role: "member",
  channels: [],
  is_owner: false,
};

describe("GET /api/chat/sessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPrincipal.mockResolvedValue(principal);
  });

  it("returns 401 when unauthenticated", async () => {
    getPrincipal.mockResolvedValue(null);
    const res = await GET(new Request("http://x/api/chat/sessions"));
    expect(res.status).toBe(401);
    expect(sessions).not.toHaveBeenCalled();
  });

  it("passes no limit when the query has none", async () => {
    const res = await GET(new Request("http://x/api/chat/sessions"));
    expect(res.status).toBe(200);
    expect(sessions).toHaveBeenCalledWith(
      expect.objectContaining({ limit: undefined }),
    );
  });

  it("treats a garbage limit as absent, not as one session", async () => {
    await GET(new Request("http://x/api/chat/sessions?limit=abc"));
    expect(sessions).toHaveBeenCalledWith(
      expect.objectContaining({ limit: undefined }),
    );
  });

  it("forwards an explicit limit", async () => {
    await GET(new Request("http://x/api/chat/sessions?limit=200"));
    expect(sessions).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 200 }),
    );
  });

  it("reads every page for limit=all, keeping the filters", async () => {
    await GET(
      new Request("http://x/api/chat/sessions?limit=all&exclude_sources=&tags=a&tag_match=all"),
    );
    expect(sessions).not.toHaveBeenCalled();
    expect(allSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        excludeSources: undefined,
        order: "recent",
        tags: "a",
        tagMatch: "all",
      }),
    );
  });

  it("clamps an oversized limit to the 200 cap", async () => {
    await GET(new Request("http://x/api/chat/sessions?limit=5000"));
    expect(sessions).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 200 }),
    );
  });

  it("forwards a source filter", async () => {
    await GET(new Request("http://x/api/chat/sessions?source=agent_home"));
    expect(sessions).toHaveBeenCalledWith(expect.objectContaining({ source: "agent_home" }));
    await GET(new Request("http://x/api/chat/sessions"));
    expect(sessions).toHaveBeenLastCalledWith(expect.objectContaining({ source: undefined }));
  });
});
