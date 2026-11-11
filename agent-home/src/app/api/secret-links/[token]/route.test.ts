import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET, POST } from "@/app/api/secret-links/[token]/route";
import { HermesApiError } from "@/lib/api/client";
import { isPublicApiRoute } from "@/lib/apps/guard";

const secretLinkInfo = vi.fn();
const submitSecretLink = vi.fn();

vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>();
  return {
    ...actual,
    HermesApiClient: class {
      secretLinkInfo(...args: unknown[]) {
        return secretLinkInfo(...args);
      }
      submitSecretLink(...args: unknown[]) {
        return submitSecretLink(...args);
      }
    },
  };
});

const TOKEN = "Q".repeat(43);
const SECRET = "ghp_VERY_SECRET_value_123";
const ctx = (token = TOKEN) => ({ params: Promise.resolve({ token }) });
const INFO = {
  ok: true,
  label: "GitHub token",
  purpose: "Open the PR",
  kind: "secret",
  username: null,
  expires_at: 1_900_000_000,
};

function req(body?: unknown, ip = "203.0.113.9"): Request {
  return new Request(`http://localhost/api/secret-links/${TOKEN}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

function expectPrivate(res: Response) {
  expect(res.headers.get("cache-control")).toContain("no-store");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
}

describe("/api/secret-links/[token]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is public: no sign-in, and no Referer needed", () => {
    expect(isPublicApiRoute("GET", `/api/secret-links/${TOKEN}`)).toBe(true);
    expect(isPublicApiRoute("POST", `/api/secret-links/${TOKEN}`)).toBe(true);
  });

  it("GET forwards the token and caller IP and returns what is asked for", async () => {
    secretLinkInfo.mockResolvedValue(INFO);
    const res = (await GET(req(), ctx())) as unknown as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(INFO);
    expect(secretLinkInfo).toHaveBeenCalledWith(TOKEN, "203.0.113.9");
    expectPrivate(res);
  });

  it("any upstream refusal is the same neutral 404", async () => {
    secretLinkInfo.mockRejectedValue(new HermesApiError(404, "nope"));
    const a = (await GET(req(), ctx())) as unknown as Response;
    const b = (await GET(req(), ctx("bad token!"))) as unknown as Response;
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    expect(await a.text()).toBe(await b.text());
    expect(secretLinkInfo).toHaveBeenCalledTimes(1);
    expectPrivate(a);
  });

  it("POST stores the values and never echoes them", async () => {
    submitSecretLink.mockResolvedValue({ ok: true, status: "stored", name: "github_pat", extra: SECRET });
    const res = (await POST(req({ values: { value: SECRET } }), ctx())) as unknown as Response;
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: true, status: "stored", name: "github_pat" });
    expect(text).not.toContain(SECRET);
    expect(submitSecretLink).toHaveBeenCalledWith(TOKEN, { values: { value: SECRET } }, "203.0.113.9");
    expectPrivate(res);
  });

  it("POST declines", async () => {
    submitSecretLink.mockResolvedValue({ ok: true, status: "declined" });
    const res = (await POST(req({ decline: true }), ctx())) as unknown as Response;
    expect(await res.json()).toEqual({ ok: true, status: "declined" });
    expect(submitSecretLink).toHaveBeenCalledWith(TOKEN, { decline: true }, "203.0.113.9");
  });

  it("refuses malformed bodies before calling upstream", async () => {
    for (const body of ["not json", {}, { values: {} }, { values: { value: 5 } }, { values: [SECRET] }]) {
      const res = (await POST(req(body), ctx())) as unknown as Response;
      expect(res.status).toBe(400);
      expect(await res.text()).not.toContain(SECRET);
    }
    expect(submitSecretLink).not.toHaveBeenCalled();
  });

  it("maps used/expired to 404, throttling to 429 and outages to 502", async () => {
    submitSecretLink.mockRejectedValueOnce(new HermesApiError(404, "x"));
    submitSecretLink.mockRejectedValueOnce(new HermesApiError(429, "x"));
    submitSecretLink.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const codes = [];
    for (let i = 0; i < 3; i++) {
      codes.push(((await POST(req({ values: { value: SECRET } }), ctx())) as unknown as Response).status);
    }
    expect(codes).toEqual([404, 429, 502]);
  });

  it("never logs the token or the value", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    submitSecretLink.mockRejectedValue(new Error(`boom ${SECRET}`));
    await POST(req({ values: { value: SECRET } }), ctx());
    secretLinkInfo.mockRejectedValue(new Error("boom"));
    await GET(req(), ctx());
    const logged = spies.flatMap((s) => s.mock.calls.flat().map(String)).join("\n");
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(TOKEN);
    spies.forEach((s) => s.mockRestore());
  });
});
