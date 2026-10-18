/**
 * BFF route tests for /api/models/provider-key — the validate-then-save
 * flow for provider API keys. The contract that matters: a *confirmed-bad*
 * key is refused; an *unreachable* probe does not block the save (some
 * providers have no live probe); and the key value never appears in any
 * response body.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DELETE, POST } from "@/app/api/models/provider-key/route";
import type { Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const validateProviderKey = vi.fn();
const setEnvVar = vi.fn(async () => ({ ok: true, key: "OPENCODE_GO_API_KEY" }));
const deleteEnvVar = vi.fn(async () => ({ ok: true, key: "OPENCODE_GO_API_KEY" }));

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async () => ({
    validateProviderKey,
    setEnvVar,
    deleteEnvVar,
  }),
}));

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://home.test/api/models/provider-key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  ) as unknown as Promise<Response>;
}

function del(body: unknown): Promise<Response> {
  return DELETE(
    new Request("http://home.test/api/models/provider-key", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  ) as unknown as Promise<Response>;
}

describe("POST /api/models/provider-key", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPrincipal.mockResolvedValue({
      user_id: "leo",
      display: "Leo",
      role: "owner",
      channels: [],
      is_owner: true,
    });
    validateProviderKey.mockResolvedValue({
      ok: true,
      reachable: true,
      message: "ok",
    });
  });

  it("returns 401 when unauthenticated", async () => {
    getPrincipal.mockResolvedValue(null);
    const res = await post({ key: "OPENCODE_GO_API_KEY", value: "sk-x" });
    expect(res.status).toBe(401);
  });

  it("returns 403 for a member and writes nothing", async () => {
    getPrincipal.mockResolvedValue({
      user_id: "mia",
      display: "Mia",
      role: "member",
      channels: [],
      is_owner: false,
    });
    const res = await post({
      key: "OPENCODE_GO_API_KEY",
      value: "sk-x",
      extra_env: { OPENAI_BASE_URL: "https://evil.example" },
    });
    expect(res.status).toBe(403);
    expect(validateProviderKey).not.toHaveBeenCalled();
    expect(setEnvVar).not.toHaveBeenCalled();
  });

  it("returns 400 on a non-env-var key name", async () => {
    const res = await post({ key: "not a key!", value: "sk-x" });
    expect(res.status).toBe(400);
    expect(validateProviderKey).not.toHaveBeenCalled();
  });

  it("returns 400 on an empty value", async () => {
    const res = await post({ key: "OPENCODE_GO_API_KEY", value: "  " });
    expect(res.status).toBe(400);
    expect(validateProviderKey).not.toHaveBeenCalled();
  });

  it("refuses a confirmed-bad key without writing .env", async () => {
    validateProviderKey.mockResolvedValue({
      ok: false,
      reachable: true,
      message: "401 unauthorized",
    });
    const res = await post({ key: "OPENCODE_GO_API_KEY", value: "sk-bad" });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.detail).toContain("401");
    expect(setEnvVar).not.toHaveBeenCalled();
  });

  it("saves an unverifiable key and marks it unverified", async () => {
    validateProviderKey.mockResolvedValue({
      ok: false,
      reachable: false,
      message: "no live probe for this provider",
    });
    const res = await post({ key: "OPENCODE_GO_API_KEY", value: "sk-maybe" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.verified).toBe(false);
    expect(setEnvVar).toHaveBeenCalledWith("OPENCODE_GO_API_KEY", "sk-maybe");
  });

  it("saves a verified key and never echoes the value back", async () => {
    const res = await post({ key: "OPENCODE_GO_API_KEY", value: "sk-secret-value" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.verified).toBe(true);
    expect(JSON.stringify(data)).not.toContain("sk-secret-value");
  });
});

describe("DELETE /api/models/provider-key", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPrincipal.mockResolvedValue({
      user_id: "leo",
      display: "Leo",
      role: "owner",
      channels: [],
      is_owner: true,
    });
  });

  it("returns 401 when unauthenticated", async () => {
    getPrincipal.mockResolvedValue(null);
    const res = await del({ key: "OPENCODE_GO_API_KEY" });
    expect(res.status).toBe(401);
  });

  it("returns 403 for a viewer and deletes nothing", async () => {
    getPrincipal.mockResolvedValue({
      user_id: "tom",
      display: "Tom",
      role: "viewer",
      channels: [],
      is_owner: false,
    });
    const res = await del({ key: "OPENCODE_GO_API_KEY" });
    expect(res.status).toBe(403);
    expect(deleteEnvVar).not.toHaveBeenCalled();
  });

  it("returns 400 on a non-env-var key name", async () => {
    const res = await del({ key: "drop table;" });
    expect(res.status).toBe(400);
    expect(deleteEnvVar).not.toHaveBeenCalled();
  });

  it("deletes the env var", async () => {
    const res = await del({ key: "OPENCODE_GO_API_KEY" });
    expect(res.status).toBe(200);
    expect(deleteEnvVar).toHaveBeenCalledWith("OPENCODE_GO_API_KEY");
  });
});
