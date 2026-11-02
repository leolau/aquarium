/**
 * BFF tests for the per-person SQL Server connections: every route needs a
 * signed-in principal, forwards under the bridged client and passes Hermes
 * errors on.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DELETE, PUT } from "@/app/api/mssql/connections/[name]/route";
import { POST } from "@/app/api/mssql/connections/[name]/test/route";
import { GET } from "@/app/api/mssql/connections/route";
import { HermesApiError } from "@/lib/api/client";
import type { Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const mssqlConnections = vi.fn();
const putMssqlConnection = vi.fn();
const deleteMssqlConnection = vi.fn();
const testMssqlConnection = vi.fn();

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async () => ({
    mssqlConnections, putMssqlConnection, deleteMssqlConnection, testMssqlConnection,
  }),
}));

const ALICE: Principal = { user_id: "alice", display: "Alice", role: "member", channels: [], is_owner: false };
const ctx = (name: string) => ({ params: Promise.resolve({ name }) });
const put = (body: unknown) =>
  new Request("http://localhost/api/mssql/connections/x", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  getPrincipal.mockResolvedValue(ALICE);
});

describe("unauthenticated", () => {
  it("401s on every route and never calls Hermes", async () => {
    getPrincipal.mockResolvedValue(null);
    const responses = [
      await GET(),
      await PUT(put({}), ctx("ERP")),
      await DELETE(new Request("http://localhost"), ctx("ERP")),
      await POST(new Request("http://localhost"), ctx("ERP")),
    ];
    expect(responses.map((r) => r.status)).toEqual([401, 401, 401, 401]);
    for (const fn of [mssqlConnections, putMssqlConnection, deleteMssqlConnection, testMssqlConnection]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });
});

describe("forwarding", () => {
  it("GET lists the caller's connections", async () => {
    mssqlConnections.mockResolvedValue({ connections: [], driver_available: true });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connections: [], driver_available: true });
  });

  it("PUT forwards the name and body; bad JSON is a 400", async () => {
    putMssqlConnection.mockResolvedValue({ connection: { name: "ERP" } });
    const res = await PUT(put({ host: "sql01" }), ctx("ERP"));
    expect(res.status).toBe(200);
    expect(putMssqlConnection).toHaveBeenCalledWith("ERP", { host: "sql01" });
    expect((await PUT(put("{nope"), ctx("ERP"))).status).toBe(400);
    expect((await PUT(put([1]), ctx("ERP"))).status).toBe(400);
  });

  it("passes Hermes 403/404 through", async () => {
    putMssqlConnection.mockRejectedValue(new HermesApiError(403, "only the owner can allow changes"));
    expect((await PUT(put({ allow_writes: true }), ctx("ERP"))).status).toBe(403);
    testMssqlConnection.mockRejectedValue(new HermesApiError(404, "no SQL Server connection with that name"));
    expect((await POST(new Request("http://localhost"), ctx("Bobs"))).status).toBe(404);
    deleteMssqlConnection.mockRejectedValue(new HermesApiError(404, "no SQL Server connection with that name"));
    expect((await DELETE(new Request("http://localhost"), ctx("Bobs"))).status).toBe(404);
  });

  it("502s when Hermes is unreachable", async () => {
    mssqlConnections.mockRejectedValue(new Error("ECONNREFUSED"));
    expect((await GET()).status).toBe(502);
  });
});
