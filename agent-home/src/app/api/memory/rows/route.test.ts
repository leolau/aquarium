/**
 * FG-23 §7 — BFF route handler tests: 401 without principal,
 * HermesApiError → same status, unreachable → 502, POST forwards text only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET as rowsGET } from "@/app/api/memory/rows/route";
import { GET as projectionGET } from "@/app/api/memory/projection/route";
import { POST as queryPOST } from "@/app/api/memory/query/route";
import { HermesApiError } from "@/lib/api/client";
import type { Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const memoryRows = vi.fn();
const memoryProjection = vi.fn();
const memoryQuery = vi.fn();

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async () => ({
    memoryRows,
    memoryProjection,
    memoryQuery,
  }),
}));

const PRINCIPAL: Principal = {
  user_id: "leo_owner",
  display: "Leo",
  role: "owner",
  channels: [],
  is_owner: true,
};

function makeReq(url: string, init?: RequestInit): Request {
  return new Request(`http://home.test${url}`, init);
}

describe("GET /api/memory/rows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPrincipal.mockResolvedValue(PRINCIPAL);
  });

  it("returns 401 without a principal", async () => {
    getPrincipal.mockResolvedValue(null);
    const res = await rowsGET(makeReq("/api/memory/rows") as never);
    expect(res.status).toBe(401);
  });

  it("forwards query params and returns 200", async () => {
    memoryRows.mockResolvedValue({ rows: [], total: 0, limit: 25, offset: 0 });
    const res = await rowsGET(
      makeReq("/api/memory/rows?q=test&limit=10&offset=5") as never,
    );
    expect(res.status).toBe(200);
    expect(memoryRows).toHaveBeenCalledWith(
      expect.objectContaining({ q: "test", limit: 10, offset: 5 }),
    );
  });

  it("maps HermesApiError to its status", async () => {
    memoryRows.mockRejectedValue(new HermesApiError(403, "forbidden"));
    const res = await rowsGET(makeReq("/api/memory/rows") as never);
    expect(res.status).toBe(403);
  });

  it("returns 502 on unreachable API", async () => {
    memoryRows.mockRejectedValue(new Error("fetch failed"));
    const res = await rowsGET(makeReq("/api/memory/rows") as never);
    expect(res.status).toBe(502);
  });
});

describe("GET /api/memory/projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPrincipal.mockResolvedValue(PRINCIPAL);
  });

  it("returns 401 without a principal", async () => {
    getPrincipal.mockResolvedValue(null);
    const res = await projectionGET(makeReq("/api/memory/projection") as never);
    expect(res.status).toBe(401);
  });

  it("forwards limit and returns 200", async () => {
    memoryProjection.mockResolvedValue({ algorithm: "pca", points: [], stale: false });
    const res = await projectionGET(
      makeReq("/api/memory/projection?limit=5000") as never,
    );
    expect(res.status).toBe(200);
    expect(memoryProjection).toHaveBeenCalledWith(5000, undefined);
  });

  it("forwards owners= as a list", async () => {
    memoryProjection.mockResolvedValue({ algorithm: "pca", points: [], stale: false });
    const res = await projectionGET(
      makeReq("/api/memory/projection?owners=ada,bob") as never,
    );
    expect(res.status).toBe(200);
    expect(memoryProjection).toHaveBeenCalledWith(undefined, ["ada", "bob"]);
  });
});

describe("POST /api/memory/query", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPrincipal.mockResolvedValue(PRINCIPAL);
  });

  it("returns 401 without a principal", async () => {
    getPrincipal.mockResolvedValue(null);
    const res = await queryPOST(
      makeReq("/api/memory/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      }) as never,
    );
    expect(res.status).toBe(401);
  });

  it("forwards text and nothing else", async () => {
    memoryQuery.mockResolvedValue({ x: 1, y: 2, nearest: [] });
    const res = await queryPOST(
      makeReq("/api/memory/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hello", mode: "dev", extra: "x" }),
      }) as never,
    );
    expect(res.status).toBe(200);
    expect(memoryQuery).toHaveBeenCalledWith("hello");
    expect(memoryQuery).not.toHaveBeenCalledWith(expect.stringContaining("mode"));
  });

  it("returns 400 when text is empty", async () => {
    const res = await queryPOST(
      makeReq("/api/memory/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "" }),
      }) as never,
    );
    expect(res.status).toBe(400);
    expect(memoryQuery).not.toHaveBeenCalled();
  });

  it("maps HermesApiError to its status", async () => {
    memoryQuery.mockRejectedValue(new HermesApiError(429, "rate limited"));
    const res = await queryPOST(
      makeReq("/api/memory/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      }) as never,
    );
    expect(res.status).toBe(429);
  });
});
