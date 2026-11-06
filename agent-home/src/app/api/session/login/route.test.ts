import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MyProfile, Role } from "@/types";

const writeSession = vi.fn();
const writeLastProfileHint = vi.fn();
let hint: string | null = null;
vi.mock("@/lib/auth/session", () => ({
  writeSession: (...a: unknown[]) => writeSession(...a),
  writeLastProfileHint: (...a: unknown[]) => writeLastProfileHint(...a),
  readLastProfileHint: async () => hint,
}));
// `whoami` in a profile answers with that profile's own role — the authority
// is profile-local, so the role in the session must be the landing profile's.
const ROLE_IN: Record<string, Role> = { default: "owner", hr: "member", sales: "viewer" };
const whoamiProfiles: (string | undefined)[] = [];
vi.mock("@/lib/auth/principal", () => ({
  resolvePrincipalOrStatus: async (_token: string, profile?: string) => {
    whoamiProfiles.push(profile);
    return {
      kind: "principal",
      principal: {
        user_id: "u1",
        display: "U",
        role: ROLE_IN[profile ?? "default"],
        channels: [],
        is_owner: false,
      },
    };
  },
}));
vi.mock("@/lib/env", () => ({ hermesApiBaseUrl: () => "http://api" }));
vi.mock("@/i18n/sync", () => ({ syncLanguageAtLogin: async () => {} }));

import { POST } from "./route";

function req(body: unknown): Request {
  return new Request("http://x/api/session/login", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const creds = { provider: "supabase", username: "o@x.io", password: "pw-123456789012" };
let upstream: Response;
let enrolments: MyProfile[] = [{ name: "default", role: "owner", active: true, is_default: true }];
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const fetchMock = vi.fn(async (url: unknown, _init?: unknown) =>
  String(url).endsWith("/api/auth/my-profiles")
    ? Response.json({ profiles: enrolments })
    : upstream,
);

beforeEach(() => {
  writeSession.mockReset();
  writeLastProfileHint.mockReset();
  fetchMock.mockClear();
  whoamiProfiles.length = 0;
  hint = null;
  enrolments = [{ name: "default", role: "owner", active: true, is_default: true }];
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

const signedIn = () =>
  new Response(JSON.stringify({ ok: true, next: "/" }), {
    headers: { "set-cookie": "hermes_session_at=tok; Path=/", "content-type": "application/json" },
  });

const enrolled = (name: string, active = true, role: Role = "member"): MyProfile => ({
  name,
  role,
  active,
  is_default: name === "default",
});

describe("POST /api/session/login lands in an enrolled profile (FG-28 D1)", () => {
  it("lands someone enrolled only in hr in hr, with hr's role", async () => {
    upstream = signedIn();
    enrolments = [enrolled("hr")];
    const res = await POST(req(creds));
    expect(res.status).toBe(200);
    expect((await res.json()).profile).toBe("hr");
    expect(whoamiProfiles).toEqual(["hr"]);
    const session = writeSession.mock.calls[0][0];
    expect(session.profile).toBe("hr");
    expect(session.principal.role).toBe(ROLE_IN.hr);
    expect(writeLastProfileHint).toHaveBeenCalledWith("hr");
  });

  it("honours the last-profile hint only while still enrolled there", async () => {
    enrolments = [enrolled("default"), enrolled("hr"), enrolled("sales")];
    upstream = signedIn();
    hint = "sales";
    await POST(req(creds));
    expect(writeSession.mock.calls[0][0].profile).toBe("sales");

    // A hint for a profile the account has left — or is suspended in — is
    // only a preference: it lands in default, never in the hinted profile.
    for (const list of [
      [enrolled("default"), enrolled("hr")],
      [enrolled("default"), enrolled("sales", false)],
    ]) {
      writeSession.mockReset();
      enrolments = list;
      upstream = signedIn();
      await POST(req(creds));
      expect(writeSession.mock.calls[0][0].profile).toBe("default");
    }
  });

  it("prefers ?profile= over the hint, and ignores it where not enrolled", async () => {
    enrolments = [enrolled("default"), enrolled("hr"), enrolled("sales")];
    hint = "sales";
    upstream = signedIn();
    await POST(req({ ...creds, profile: "hr" }));
    expect(writeSession.mock.calls[0][0].profile).toBe("hr");

    writeSession.mockReset();
    upstream = signedIn();
    await POST(req({ ...creds, profile: "finance" }));
    expect(writeSession.mock.calls[0][0].profile).toBe("sales");
  });

  it("refuses with 403 suspended when every enrolment is suspended", async () => {
    upstream = signedIn();
    enrolments = [enrolled("default", false), enrolled("hr", false)];
    const res = await POST(req(creds));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("suspended");
    expect(writeSession).not.toHaveBeenCalled();
    expect(writeLastProfileHint).not.toHaveBeenCalled();
  });

  it("refuses with 409 no_principal when enrolled nowhere", async () => {
    upstream = signedIn();
    enrolments = [];
    const res = await POST(req(creds));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("no_principal");
    expect(writeSession).not.toHaveBeenCalled();
  });
});
