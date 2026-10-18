import { beforeEach, describe, expect, it, vi } from "vitest";

const setupCheck = vi.fn();
const setupOwner = vi.fn();

vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>();
  return {
    ...actual,
    HermesApiClient: class {
      setupCheck(...args: unknown[]) {
        return setupCheck(...args);
      }
      setupOwner(...args: unknown[]) {
        return setupOwner(...args);
      }
    },
  };
});

import { HermesApiError } from "@/lib/api/client";

import { POST as check } from "./check/route";
import { POST as owner } from "./owner/route";

function post(body: unknown): Request {
  return new Request("http://localhost/api/auth/setup/x", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
    body: JSON.stringify(body),
  });
}

describe("first-run setup proxies", () => {
  beforeEach(() => {
    setupCheck.mockReset();
    setupOwner.mockReset();
  });

  it("forwards the token in the body to the dashboard check", async () => {
    setupCheck.mockResolvedValue({ ok: true });
    const res = await check(post({ token: "tok" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(setupCheck.mock.calls[0][0]).toBe("tok");
  });

  it("forwards token, email and password to the dashboard owner setup", async () => {
    setupOwner.mockResolvedValue({ ok: true });
    const res = await owner(post({ token: "tok", email: "o@example.com", password: "pw", extra: 1 }));
    expect(res.status).toBe(200);
    expect(setupOwner.mock.calls[0][0]).toEqual({ token: "tok", email: "o@example.com", password: "pw" });
  });

  it("passes the dashboard's neutral 400 through unchanged", async () => {
    setupOwner.mockRejectedValue(new HermesApiError(400, "This setup link cannot be used."));
    const res = await owner(post({ token: "bad" }));
    expect(res.status).toBe(400);
    expect((await res.json()).detail).toBe("This setup link cannot be used.");
  });

  it("answers 502 when the dashboard is unreachable and 400 on bad JSON", async () => {
    setupCheck.mockRejectedValue(new TypeError("fetch failed"));
    expect((await check(post({ token: "t" }))).status).toBe(502);
    const bad = new Request("http://localhost/x", { method: "POST", body: "{" });
    expect((await check(bad)).status).toBe(400);
  });
});
