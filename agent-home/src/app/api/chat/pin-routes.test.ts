/**
 * BFF tests for the landing pin routes: auth, validation, profile routing,
 * Idempotency-Key forwarding and upstream error mapping.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET as getSuggestions } from "@/app/api/chat/pin-suggestions/route";
import { POST as dismiss } from "@/app/api/chat/pin-suggestions/dismiss/route";
import { POST as pin } from "@/app/api/chat/sessions/pin/route";
import { HermesApiError } from "@/lib/api/client";
import type { Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const apiClientForRequest = vi.fn();
const setSessionPinned = vi.fn();
const pinSuggestions = vi.fn();
const dismissPinSuggestions = vi.fn();
const forwardIdempotencyKey = vi.fn();
let incomingHeaders = new Headers();

vi.mock("next/headers", () => ({ headers: async () => incomingHeaders }));
vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: (opts: unknown) => apiClientForRequest(opts),
}));

const principal: Principal = {
  user_id: "mia",
  display: "Mia",
  role: "member",
  channels: [],
  is_owner: false,
};

function post(url: string, body: unknown): Request {
  return new Request(url, { method: "POST", body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.clearAllMocks();
  incomingHeaders = new Headers();
  getPrincipal.mockResolvedValue(principal);
  const client = { setSessionPinned, pinSuggestions, dismissPinSuggestions, forwardIdempotencyKey };
  forwardIdempotencyKey.mockReturnValue(client);
  apiClientForRequest.mockResolvedValue(client);
});

describe("POST /api/chat/sessions/pin", () => {
  it("401s without a principal", async () => {
    getPrincipal.mockResolvedValue(null);
    const res = await pin(post("http://x/api/chat/sessions/pin", { sessionId: "s", pinned: true }));
    expect(res.status).toBe(401);
    expect(setSessionPinned).not.toHaveBeenCalled();
  });

  it("validates the body", async () => {
    expect((await pin(post("http://x", { pinned: true }))).status).toBe(400);
    expect((await pin(post("http://x", { sessionId: "s" }))).status).toBe(400);
    expect((await pin(new Request("http://x", { method: "POST", body: "{" }))).status).toBe(400);
  });

  it("pins in the requested profile and forwards the idempotency key", async () => {
    incomingHeaders = new Headers({ "idempotency-key": "k1" });
    setSessionPinned.mockResolvedValue({ session_id: "s", pinned_at: 12 });
    const res = await pin(
      post("http://x", { sessionId: "s", pinned: true, profile: "work" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ session_id: "s", pinned_at: 12 });
    expect(apiClientForRequest).toHaveBeenCalledWith({ profile: "work" });
    expect(forwardIdempotencyKey).toHaveBeenCalledWith("k1");
    expect(setSessionPinned).toHaveBeenCalledWith("s", true);
  });

  it("maps upstream refusals to their status with the upstream detail", async () => {
    setSessionPinned.mockRejectedValue(
      new HermesApiError(409, "POST /api/sessions/s/pin -> 409", { detail: "You can pin up to 20 chats." }),
    );
    const res = await pin(post("http://x", { sessionId: "s", pinned: true }));
    expect(res.status).toBe(409);
    expect((await res.json()).detail).toBe("You can pin up to 20 chats.");
  });

  it("502s when the AI layer is unreachable", async () => {
    setSessionPinned.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await pin(post("http://x", { sessionId: "s", pinned: false }));
    expect(res.status).toBe(502);
  });
});

describe("GET /api/chat/pin-suggestions", () => {
  it("reads the profile from the query", async () => {
    pinSuggestions.mockResolvedValue({ items: [], generated_at: null });
    const res = await getSuggestions(new Request("http://x/api/chat/pin-suggestions?profile=work"));
    expect(res.status).toBe(200);
    expect(apiClientForRequest).toHaveBeenCalledWith({ profile: "work" });
  });
});

describe("POST /api/chat/pin-suggestions/dismiss", () => {
  it("requires ids and forwards clean ones", async () => {
    expect((await dismiss(post("http://x", { sessionIds: [] }))).status).toBe(400);
    dismissPinSuggestions.mockResolvedValue({ dismissed: ["a"] });
    const res = await dismiss(post("http://x", { sessionIds: ["a", 3, ""] }));
    expect(res.status).toBe(200);
    expect(dismissPinSuggestions).toHaveBeenCalledWith(["a"]);
  });
});
