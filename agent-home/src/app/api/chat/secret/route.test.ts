/**
 * POST /api/chat/secret (FG-37): the BFF seam that answers a secret request.
 * It must be signed in, forward only well-formed answers, never echo the
 * value (not even in errors) and never be cached.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/chat/secret/route";
import { HermesApiError } from "@/lib/api/client";
import type { Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const apiClientForRequest = vi.fn();
const resolveSecretRequest = vi.fn();

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: (opts: unknown) => apiClientForRequest(opts),
}));

const SECRET = "ghp_SuperSecretValue1234567890abcdefXYZ";

function post(body: unknown) {
  return POST(
    new Request("http://home.test/api/chat/secret", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getPrincipal.mockResolvedValue({ user_id: "mia_member" } as Principal);
  apiClientForRequest.mockResolvedValue({ resolveSecretRequest });
  resolveSecretRequest.mockResolvedValue({ status: "fulfilled", name: "github-pat" });
});

describe("POST /api/chat/secret", () => {
  it("rejects anonymous callers before touching the API", async () => {
    getPrincipal.mockResolvedValue(null);
    const res = await post({ request_id: "sr_0123456789abcdef", values: { value: SECRET } });
    expect(res.status).toBe(401);
    expect(resolveSecretRequest).not.toHaveBeenCalled();
  });

  it("forwards a value to the request route and never echoes it", async () => {
    const res = await post({
      request_id: "sr_0123456789abcdef",
      values: { value: SECRET },
      profile: "work",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(apiClientForRequest).toHaveBeenCalledWith({ profile: "work" });
    expect(resolveSecretRequest).toHaveBeenCalledWith("sr_0123456789abcdef", {
      values: { value: SECRET },
    });
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    expect(JSON.parse(text)).toEqual({ ok: true, status: "fulfilled" });
  });

  it("forwards username + password answers", async () => {
    await post({
      request_id: "sr_0123456789abcdef",
      values: { username: "mia", password: "hunter22" },
    });
    expect(resolveSecretRequest).toHaveBeenCalledWith("sr_0123456789abcdef", {
      values: { username: "mia", password: "hunter22" },
    });
  });

  it("forwards a decline without values", async () => {
    const res = await post({ request_id: "sr_0123456789abcdef", decline: true });
    expect(res.status).toBe(200);
    expect(resolveSecretRequest).toHaveBeenCalledWith("sr_0123456789abcdef", { decline: true });
  });

  it.each([
    ["no request id", { values: { value: SECRET } }],
    ["a malformed request id", { request_id: "../etc", values: { value: SECRET } }],
    ["neither values nor decline", { request_id: "sr_0123456789abcdef" }],
    ["both values and decline", { request_id: "sr_0123456789abcdef", decline: true, values: { value: "x" } }],
    ["an empty value", { request_id: "sr_0123456789abcdef", values: { value: "" } }],
    ["an unknown field", { request_id: "sr_0123456789abcdef", values: { value: "x", note: "y" } }],
    ["a non-string value", { request_id: "sr_0123456789abcdef", values: { value: 42 } }],
    ["a password without a password", { request_id: "sr_0123456789abcdef", values: { username: "mia" } }],
  ])("rejects %s with 400", async (_label, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(resolveSecretRequest).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON", async () => {
    const res = await post("{not json");
    expect(res.status).toBe(400);
  });

  it("maps upstream errors to fixed text, never the upstream message", async () => {
    resolveSecretRequest.mockRejectedValue(
      new HermesApiError(409, `already answered: ${SECRET}`, {}),
    );
    const res = await post({ request_id: "sr_0123456789abcdef", values: { value: SECRET } });
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    expect(JSON.parse(text).detail).toMatch(/already answered or has expired/);
  });

  it("answers 502 when the API is unreachable", async () => {
    resolveSecretRequest.mockRejectedValue(new TypeError("fetch failed"));
    const res = await post({ request_id: "sr_0123456789abcdef", decline: true });
    expect(res.status).toBe(502);
  });
});
