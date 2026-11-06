import { beforeEach, describe, expect, it, vi } from "vitest";

const redeemInvitation = vi.fn();
const requestInvitation = vi.fn();

vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>();
  return {
    ...actual,
    HermesApiClient: class {
      redeemInvitation(...args: unknown[]) {
        return redeemInvitation(...args);
      }
      requestInvitation(...args: unknown[]) {
        return requestInvitation(...args);
      }
    },
  };
});

import { HermesApiError } from "@/lib/api/client";

import { POST as redeem } from "./redeem/route";
import { POST as request } from "./request/route";

function post(body: unknown): Request {
  return new Request("http://localhost/api/auth/invitations/x", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
    body: JSON.stringify(body),
  });
}

describe("invitation redeem proxy", () => {
  beforeEach(() => {
    redeemInvitation.mockReset();
  });

  it("forwards the link's profile with the token and password", async () => {
    redeemInvitation.mockResolvedValue({ ok: true });
    const res = await redeem(post({ token: "tok", password: "pw", profile: "hr" }));
    expect(res.status).toBe(200);
    expect(redeemInvitation.mock.calls[0]).toEqual([
      { token: "tok", password: "pw", profile: "hr" },
      "203.0.113.9",
    ]);
  });

  it("sends no profile for a legacy link, meaning the default profile", async () => {
    redeemInvitation.mockResolvedValue({ ok: true });
    await redeem(post({ token: "tok", password: "pw" }));
    expect(redeemInvitation.mock.calls[0][0]).toEqual({ token: "tok", password: "pw" });
  });

  it("passes the neutral 400 for a wrong profile through unchanged", async () => {
    redeemInvitation.mockRejectedValue(new HermesApiError(400, "This link cannot be used."));
    const res = await redeem(post({ token: "tok", password: "pw", profile: "nope" }));
    expect(res.status).toBe(400);
    expect((await res.json()).detail).toBe("This link cannot be used.");
  });
});

describe("reset request proxy", () => {
  beforeEach(() => {
    requestInvitation.mockReset();
  });

  it("forwards the sign-in page's profile hint", async () => {
    requestInvitation.mockResolvedValue({ ok: true });
    const res = await request(post({ email: "a@x.io", profile: "hr" }));
    expect(await res.json()).toEqual({ ok: true });
    expect(requestInvitation.mock.calls[0]).toEqual(["a@x.io", "203.0.113.9", "hr"]);
  });

  it("answers ok whatever upstream said", async () => {
    requestInvitation.mockRejectedValue(new HermesApiError(500, "boom"));
    const res = await request(post({ email: "a@x.io" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(requestInvitation.mock.calls[0][2]).toBe("");
  });
});
