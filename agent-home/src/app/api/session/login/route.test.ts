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
    expect(await res.json()).toEqual({ ok: false, two_factor_required: true, provider: "supabase" });
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

describe("POST /api/session/login picks the password provider itself", () => {
  const PROVIDERS = [
    { name: "supabase", display_name: "Email & Password (Supabase)", supports_password: true },
    { name: "github", display_name: "GitHub", supports_password: false },
    { name: "basic", display_name: "Username & Password", supports_password: true },
  ];
  let answers: Response[] = [];
  const tried = () =>
    fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith("/auth/password-login"))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, string>);

  beforeEach(() => {
    answers = [];
    fetchMock.mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith("/api/auth/providers")) return Response.json({ providers: PROVIDERS });
      if (u.endsWith("/api/auth/my-profiles")) return Response.json({ profiles: enrolments });
      return answers.shift() ?? Response.json({ detail: "Invalid credentials" }, { status: 401 });
    });
  });
  afterEach(() => fetchMock.mockImplementation(async (url: unknown) =>
    String(url).endsWith("/api/auth/my-profiles") ? Response.json({ profiles: enrolments }) : upstream,
  ));

  const login = (username: string, extra: Record<string, string> = {}) =>
    POST(req({ username, password: "pw-123456789012", ...extra }));

  it("tries the email provider first for an address, and stops when it works", async () => {
    answers = [signedIn()];
    const res = await login("o@x.io");
    expect(res.status).toBe(200);
    expect(tried().map((b) => b.provider)).toEqual(["supabase"]);
    expect(writeSession).toHaveBeenCalledOnce();
  });

  it("tries the username provider first for a plain name, with provider \"auto\" too", async () => {
    answers = [signedIn()];
    await login("admin", { provider: "auto" });
    expect(tried().map((b) => b.provider)).toEqual(["basic"]);
  });

  it("falls back to the other password provider exactly once", async () => {
    answers = [
      Response.json({ detail: "Invalid credentials" }, { status: 401 }),
      Response.json({ detail: "Invalid credentials" }, { status: 401 }),
    ];
    const res = await login("admin");
    expect(tried().map((b) => b.provider)).toEqual(["basic", "supabase"]);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "login_failed", detail: "Wrong email/username or password." });
    expect(writeSession).not.toHaveBeenCalled();
  });

  it("falls back after an unknown provider and signs in with the other one", async () => {
    answers = [Response.json({ detail: "Unknown provider" }, { status: 404 }), signedIn()];
    const res = await login("o@x.io");
    expect(tried().map((b) => b.provider)).toEqual(["supabase", "basic"]);
    expect(res.status).toBe(200);
  });

  it("does not fall back on a rate limit or an outage", async () => {
    answers = [Response.json({}, { status: 429 })];
    expect((await login("admin")).status).toBe(429);
    answers = [Response.json({}, { status: 503 })];
    const res = await login("admin");
    expect(res.status).toBe(503);
    expect(tried().map((b) => b.provider)).toEqual(["basic", "basic"]);
  });

  it("names the provider that asked for two-factor, and sends the code only there", async () => {
    answers = [
      Response.json({ detail: "Invalid credentials" }, { status: 401 }),
      Response.json({ ok: false, two_factor_required: true }),
    ];
    const first = await login("o@x.io");
    expect(await first.json()).toEqual({ ok: false, two_factor_required: true, provider: "basic" });
    fetchMock.mockClear();
    answers = [Response.json({ detail: "Invalid code" }, { status: 401 })];
    const second = await login("o@x.io", { provider: "basic", code: "000000" });
    expect((await second.json()).error).toBe("invalid_code");
    expect(tried()).toEqual([
      { provider: "basic", username: "o@x.io", password: "pw-123456789012", code: "000000" },
    ]);
  });

  it("uses the only password provider for either kind of identifier", async () => {
    fetchMock.mockImplementation(async (url: unknown) =>
      String(url).endsWith("/api/auth/providers")
        ? Response.json({ providers: [PROVIDERS[0]] })
        : Response.json({ detail: "Invalid credentials" }, { status: 401 }),
    );
    await login("admin");
    expect(tried().map((b) => b.provider)).toEqual(["supabase"]);
  });

  it("refuses when no password provider is configured", async () => {
    fetchMock.mockImplementation(async () => Response.json({ providers: [PROVIDERS[1]] }));
    const res = await login("admin");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("no_provider");
    expect(tried()).toEqual([]);
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
