/**
 * BFF tests for the per-person Windows servers (PowerShell): every route needs a
 * signed-in principal, forwards under the bridged client and passes Hermes
 * errors on.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DELETE, PUT } from "@/app/api/winrm/connections/[name]/route";
import { POST } from "@/app/api/winrm/connections/[name]/test/route";
import { GET } from "@/app/api/winrm/connections/route";
import { HermesApiError } from "@/lib/api/client";
import type { Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const winrmConnections = vi.fn();
const putWinrmConnection = vi.fn();
const deleteWinrmConnection = vi.fn();
const testWinrmConnection = vi.fn();

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async () => ({
    winrmConnections, putWinrmConnection, deleteWinrmConnection, testWinrmConnection,
  }),
}));

const ALICE: Principal = { user_id: "alice", display: "Alice", role: "member", channels: [], is_owner: false };
const ctx = (name: string) => ({ params: Promise.resolve({ name }) });
const put = (body: unknown) =>
  new Request("http://localhost/api/winrm/connections/x", {
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
      await PUT(put({}), ctx("APP01")),
      await DELETE(new Request("http://localhost"), ctx("APP01")),
      await POST(new Request("http://localhost"), ctx("APP01")),
    ];
    expect(responses.map((r) => r.status)).toEqual([401, 401, 401, 401]);
    for (const fn of [winrmConnections, putWinrmConnection, deleteWinrmConnection, testWinrmConnection]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });
});

describe("forwarding", () => {
  it("GET lists the caller's servers", async () => {
    winrmConnections.mockResolvedValue({ connections: [], driver_available: true });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connections: [], driver_available: true });
  });

  it("PUT forwards the name and body; bad JSON is a 400", async () => {
    putWinrmConnection.mockResolvedValue({ connection: { name: "APP01" } });
    const res = await PUT(put({ host: "app01" }), ctx("APP01"));
    expect(res.status).toBe(200);
    expect(putWinrmConnection).toHaveBeenCalledWith("APP01", { host: "app01" });
    expect((await PUT(put("{nope"), ctx("APP01"))).status).toBe(400);
    expect((await PUT(put([1]), ctx("APP01"))).status).toBe(400);
  });

  it("passes Hermes 400/404 through", async () => {
    putWinrmConnection.mockRejectedValue(new HermesApiError(400, "transport must be one of ntlm, kerberos, credssp"));
    expect((await PUT(put({ transport: "basic" }), ctx("APP01"))).status).toBe(400);
    testWinrmConnection.mockRejectedValue(new HermesApiError(404, "no Windows server with that name"));
    expect((await POST(new Request("http://localhost"), ctx("Bobs"))).status).toBe(404);
    deleteWinrmConnection.mockRejectedValue(new HermesApiError(404, "no Windows server with that name"));
    expect((await DELETE(new Request("http://localhost"), ctx("Bobs"))).status).toBe(404);
  });

  it("502s when Hermes is unreachable", async () => {
    winrmConnections.mockRejectedValue(new Error("ECONNREFUSED"));
    expect((await GET()).status).toBe(502);
  });
});
