/**
 * BFF contract for PUT /api/tools/apps/[name]/secrets (FG-33 P8-2 2.7):
 * who may call it, what reaches the Python API, and that a secret value
 * never comes back out — not in the answer, not in an upstream error.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PUT } from "@/app/api/tools/apps/[name]/secrets/route";
import { HermesApiError } from "@/lib/api/client";
import type { Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const request = vi.fn();

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async () => ({ request }),
}));

const VALUE = "sk_live_51HxSUPERsecretVALUE";

function who(role: Principal["role"]): Principal {
  return { user_id: "tom", display: "Tom", role, channels: [], is_owner: false };
}

function put(body: unknown, app = "weather-board", headers: Record<string, string> = {}) {
  const req = new Request(`http://x/api/tools/apps/${app}/secrets`, {
    method: "PUT",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return PUT(req, { params: Promise.resolve({ name: app }) }) as unknown as Promise<Response>;
}

describe("PUT /api/tools/apps/[name]/secrets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    getPrincipal.mockResolvedValue(who("member"));
    request.mockResolvedValue({
      slug: "weather-board",
      mode: "dev",
      secret_names: ["APP_MCP_TOKEN", "STRIPE_KEY"],
      restart_needed: true,
    });
  });

  it("refuses anonymous callers and viewers before reaching upstream", async () => {
    getPrincipal.mockResolvedValue(null);
    expect((await put({ mode: "dev", name: "STRIPE_KEY", value: VALUE })).status).toBe(401);
    getPrincipal.mockResolvedValue(who("viewer"));
    expect((await put({ mode: "dev", name: "STRIPE_KEY", value: VALUE })).status).toBe(403);
    expect(request).not.toHaveBeenCalled();
  });

  it("lets a member set a secret on their app: one PUT, the helper spec, the key forwarded", async () => {
    const res = await put(
      { mode: "prod", name: "STRIPE_KEY", value: VALUE, extra: "dropped" },
      "weather-board",
      { "Idempotency-Key": "k-1" },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(request).toHaveBeenCalledTimes(1);
    const [path, init] = request.mock.calls[0];
    expect(path).toBe("/api/tools/weather-board/secrets");
    expect(init.method).toBe("PUT");
    expect(init.json).toEqual({ mode: "prod", name: "STRIPE_KEY", value: VALUE });
    expect(init.headers).toEqual({ "Idempotency-Key": "k-1" });
    expect(String(path)).not.toContain(VALUE);
  });

  it("removes a secret with delete:true and no value", async () => {
    await put({ mode: "dev", name: "STRIPE_KEY", delete: true });
    expect(request.mock.calls[0][1].json).toEqual({ mode: "dev", name: "STRIPE_KEY", delete: true });
    const both = await put({ mode: "dev", name: "STRIPE_KEY", delete: true, value: VALUE });
    expect(both.status).toBe(400);
  });

  it("answers names only, even when upstream echoes the value", async () => {
    request.mockResolvedValue({
      mode: "dev",
      secret_names: ["STRIPE_KEY"],
      restart_needed: false,
      value: VALUE,
      echo: { value: VALUE },
    });
    const res = await put({ mode: "dev", name: "STRIPE_KEY", value: VALUE });
    const text = await res.text();
    expect(text).not.toContain(VALUE);
    expect(JSON.parse(text)).toEqual({ mode: "dev", secret_names: ["STRIPE_KEY"], restart_needed: false });
  });

  it("masks the value in an upstream error and keeps the status", async () => {
    request.mockRejectedValue(new HermesApiError(400, `bad value ${VALUE}`));
    const res = await put({ mode: "dev", name: "STRIPE_KEY", value: VALUE });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain(VALUE);
    expect(JSON.parse(text).detail).toContain("[redacted]");
  });

  it("maps an unreachable upstream to 502", async () => {
    request.mockRejectedValue(new Error("ECONNREFUSED"));
    expect((await put({ mode: "dev", name: "STRIPE_KEY", value: VALUE })).status).toBe(502);
  });

  it.each([
    ["lower-case name", { mode: "dev", name: "stripe_key", value: VALUE }],
    ["reserved prefix", { mode: "dev", name: "NEXT_PUBLIC_KEY", value: VALUE }],
    ["database DSN", { mode: "dev", name: "DATABASE_URL", value: VALUE }],
    ["runtime env", { mode: "dev", name: "PORT", value: "1" }],
    ["managed MCP bearer", { mode: "dev", name: "APP_MCP_TOKEN", value: VALUE }],
    ["bad mode", { mode: "staging", name: "STRIPE_KEY", value: VALUE }],
    ["empty value", { mode: "dev", name: "STRIPE_KEY", value: "" }],
    ["NUL in value", { mode: "dev", name: "STRIPE_KEY", value: "a\u0000b" }],
    ["value over 8 KB", { mode: "dev", name: "STRIPE_KEY", value: "x".repeat(8193) }],
    ["not an object", [1, 2]],
    ["not JSON", "{nope"],
  ])("rejects %s with 400 and never calls upstream", async (_label, body) => {
    expect((await put(body)).status).toBe(400);
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects a non-slug app name", async () => {
    expect((await put({ mode: "dev", name: "K", value: "v" }, "..%2Fetc")).status).toBe(400);
    expect((await put({ mode: "dev", name: "K", value: "v" }, "a--b")).status).toBe(400);
    expect(request).not.toHaveBeenCalled();
  });
});
