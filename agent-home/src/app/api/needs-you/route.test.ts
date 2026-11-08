/**
 * BFF route tests for GET /api/needs-you. Contract: unauthenticated → 401;
 * the backend list is relayed in the `NeedsYouResponse` shape;
 * `?include=count` asks upstream for counts only; an upstream failure is a
 * 502 (the client keeps its last good list); the read is cached per
 * session under a hashed token + role, never the raw token.
 */
import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/needs-you/route";
import type { Principal } from "@/types";
import type { NeedsYouEntry, NeedsYouResponse } from "@/types/landing";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const request = vi.fn<(path: string) => Promise<NeedsYouResponse>>();
const readSession = vi.fn<() => Promise<{ hermesToken?: string } | null>>();
const unstableCache = vi.fn<
  (fn: () => Promise<unknown>, keyParts?: string[], opts?: unknown) => () => Promise<unknown>
>((fn) => fn);

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async () => ({ request }),
}));

vi.mock("@/lib/auth/session", () => ({
  readSession: () => readSession(),
}));

vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => Promise<unknown>, keyParts?: string[], opts?: unknown) =>
    unstableCache(fn, keyParts, opts),
}));

const ITEM: NeedsYouEntry = {
  id: "card_approval:t1:send",
  source: "card_approval",
  severity: "approval",
  title: "Approve: Send to 400 people",
  context: { project_slug: "digest", task_id: "t1" },
  created_at: 1700000000,
  href: "/projects/digest/cards/t1",
  actions: [{ id: "open", label: "Open", style: "primary", href: "/projects/digest/cards/t1" }],
  reversible: false,
};

const BODY: NeedsYouResponse = {
  items: [ITEM],
  count: 1,
  by_severity: { blocking: 0, approval: 1, review: 0, fyi: 0 },
  collected_at: 1700000001,
};

function principal(role: Principal["role"]): Principal {
  return { user_id: "u", display: "U", role, channels: [], is_owner: role === "owner" };
}

function get(query = ""): Promise<Response> {
  return GET(new Request(`http://x/api/needs-you${query}`)) as unknown as Promise<Response>;
}

describe("GET /api/needs-you", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPrincipal.mockResolvedValue(principal("owner"));
    readSession.mockResolvedValue({ hermesToken: "secret-token" });
    request.mockResolvedValue(BODY);
  });

  it("returns 401 when unauthenticated", async () => {
    getPrincipal.mockResolvedValue(null);
    const res = await get();
    expect(res.status).toBe(401);
    expect(request).not.toHaveBeenCalled();
  });

  it("relays the caller's list", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(BODY);
    expect(request).toHaveBeenCalledWith("/api/needs-you");
  });

  it("asks upstream for counts only with ?include=count", async () => {
    request.mockResolvedValue({ ...BODY, items: [] });
    const res = await get("?include=count");
    expect(request).toHaveBeenCalledWith("/api/needs-you?include=count");
    const body = (await res.json()) as NeedsYouResponse;
    expect(body.items).toEqual([]);
    expect(body.count).toBe(1);
  });

  it("fills a partial upstream body to the full contract", async () => {
    request.mockResolvedValue({ items: [ITEM] } as unknown as NeedsYouResponse);
    const body = (await (await get()).json()) as NeedsYouResponse;
    expect(body.count).toBe(1);
    expect(body.by_severity).toEqual({ blocking: 0, approval: 0, review: 0, fyi: 0 });
    expect(typeof body.collected_at).toBe("number");
  });

  it("surfaces an upstream failure as 502, not an empty list", async () => {
    request.mockRejectedValue(new Error("down"));
    expect((await get()).status).toBe(502);
  });

  it("caches per session under a hashed token, role and mode", async () => {
    await get();
    await get("?include=count");
    const keys = unstableCache.mock.calls.map((c) => c[1]);
    const hash = createHash("sha256").update("secret-token").digest("hex");
    expect(keys).toEqual([
      ["needs-you", hash, "admin", "items"],
      ["needs-you", hash, "admin", "count"],
    ]);
    expect(JSON.stringify(keys)).not.toContain("secret-token");
  });

  it("keys members apart from admins", async () => {
    getPrincipal.mockResolvedValue(principal("member"));
    await get();
    expect(unstableCache.mock.calls[0][1]?.[2]).toBe("member");
  });
});
