import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const writeSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({ writeSession: (...a: unknown[]) => writeSession(...a) }));
vi.mock("@/lib/auth/principal", () => ({
  resolvePrincipalOrStatus: async () => ({
    kind: "ok",
    principal: { user_id: "root", display: "Owner", role: "owner", channels: [], is_owner: true },
  }),
}));
vi.mock("@/lib/env", () => ({ hermesApiBaseUrl: () => "http://api" }));

import { POST } from "./route";

function req(body: unknown): Request {
  return new Request("http://x/api/session/login", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const creds = { provider: "supabase", username: "o@x.io", password: "pw-123456789012" };
let upstream: Response;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const fetchMock = vi.fn(async (..._args: unknown[]) => upstream);

beforeEach(() => {
  writeSession.mockReset();
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("POST /api/session/login with two-factor", () => {
  it("asks for a code without creating a session", async () => {
    upstream = Response.json({ ok: false, two_factor_required: true });
    const res = await POST(req(creds));
    expect(await res.json()).toEqual({ ok: false, two_factor_required: true });
    expect(writeSession).not.toHaveBeenCalled();
  });

  it("forwards the code and signs in when it is accepted", async () => {
    upstream = new Response(JSON.stringify({ ok: true, next: "/" }), {
      headers: { "set-cookie": "hermes_session_at=tok; Path=/", "content-type": "application/json" },
    });
    const res = await POST(req({ ...creds, code: " 123456 " }));
    expect(res.status).toBe(200);
    const sent = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(sent.code).toBe("123456");
    expect(writeSession).toHaveBeenCalledOnce();
  });

  it("says the code is wrong (not the password) and creates no session", async () => {
    upstream = Response.json({ detail: "Invalid code" }, { status: 401 });
    const res = await POST(req({ ...creds, code: "000000" }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("invalid_code");
    expect(writeSession).not.toHaveBeenCalled();
  });

  it("keeps the old body and answer for logins without a code", async () => {
    upstream = Response.json({ detail: "Invalid credentials" }, { status: 401 });
    const res = await POST(req(creds));
    expect((await res.json()).error).toBe("login_failed");
    const sent = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(sent).toEqual(creds);
  });
});
