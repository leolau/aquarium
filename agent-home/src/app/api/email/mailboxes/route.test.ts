/**
 * BFF tests for the per-person email mailboxes: every route needs a signed-in
 * principal, forwards under the bridged client and passes Hermes errors on.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DELETE, PUT } from "@/app/api/email/mailboxes/[address]/route";
import { POST } from "@/app/api/email/mailboxes/[address]/test/route";
import { GET } from "@/app/api/email/mailboxes/route";
import { HermesApiError } from "@/lib/api/client";
import type { Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const emailMailboxes = vi.fn();
const putEmailMailbox = vi.fn();
const deleteEmailMailbox = vi.fn();
const testEmailMailbox = vi.fn();

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async () => ({
    emailMailboxes, putEmailMailbox, deleteEmailMailbox, testEmailMailbox,
  }),
}));

const ALICE: Principal = { user_id: "alice", display: "Alice", role: "member", channels: [], is_owner: false };
const ctx = (address: string) => ({ params: Promise.resolve({ address }) });
const put = (body: unknown) =>
  new Request("http://localhost/api/email/mailboxes/x", {
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
      await PUT(put({}), ctx("a@b.com")),
      await DELETE(new Request("http://localhost"), ctx("a@b.com")),
      await POST(new Request("http://localhost"), ctx("a@b.com")),
    ];
    expect(responses.map((r) => r.status)).toEqual([401, 401, 401, 401]);
    for (const fn of [emailMailboxes, putEmailMailbox, deleteEmailMailbox, testEmailMailbox]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });
});

describe("forwarding", () => {
  it("GET lists the caller's mailboxes", async () => {
    emailMailboxes.mockResolvedValue({ mailboxes: [], presets: {} });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mailboxes: [], presets: {} });
  });

  it("PUT forwards the address and body; bad JSON is a 400", async () => {
    putEmailMailbox.mockResolvedValue({ mailbox: { address: "a@b.com" } });
    const res = await PUT(put({ username: "a" }), ctx("a@b.com"));
    expect(res.status).toBe(200);
    expect(putEmailMailbox).toHaveBeenCalledWith("a@b.com", { username: "a" });
    expect((await PUT(put("{nope"), ctx("a@b.com"))).status).toBe(400);
    expect((await PUT(put([1]), ctx("a@b.com"))).status).toBe(400);
  });

  it("passes Hermes 404 (someone else's mailbox) through", async () => {
    testEmailMailbox.mockRejectedValue(new HermesApiError(404, "no mailbox with that address"));
    const res = await POST(new Request("http://localhost"), ctx("bob@b.com"));
    expect(res.status).toBe(404);
    deleteEmailMailbox.mockRejectedValue(new HermesApiError(404, "no mailbox with that address"));
    expect((await DELETE(new Request("http://localhost"), ctx("bob@b.com"))).status).toBe(404);
  });

  it("502s when Hermes is unreachable", async () => {
    emailMailboxes.mockRejectedValue(new Error("ECONNREFUSED"));
    expect((await GET()).status).toBe(502);
  });
});
