/**
 * POST /api/session/language — sets this browser's copy; saves for the person
 * only when signed in, and never takes a user id from the request.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => (jar.has(name) ? { value: jar.get(name) } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
  })),
}));

const readSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({ readSession: () => readSession() }));

const setMyLanguage = vi.fn();
const myPreferences = vi.fn();
const constructed: unknown[] = [];
vi.mock("@/lib/api/client", () => ({
  HermesApiClient: class {
    constructor(opts: unknown) {
      constructed.push(opts);
    }
    setMyLanguage = setMyLanguage;
    myPreferences = myPreferences;
  },
}));

import { syncLanguageAtLogin } from "@/i18n/sync";

import { POST } from "./route";

function post(body: unknown) {
  return POST(
    new Request("http://x/api/session/language", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  jar.clear();
  constructed.length = 0;
  readSession.mockReset();
  setMyLanguage.mockReset();
  myPreferences.mockReset();
});

describe("POST /api/session/language", () => {
  it("rejects an unsupported language without touching anything", async () => {
    const res = await post({ language: "fr" });
    expect(res.status).toBe(400);
    expect(jar.size).toBe(0);
  });

  it("before sign-in, only remembers the choice in this browser", async () => {
    readSession.mockResolvedValue(null);
    const res = await post({ language: "zh-Hant" });
    expect(await res.json()).toEqual({ language: "zh-Hant", saved: false });
    expect(jar.get("aq_lang")).toBe("zh-Hant");
    expect(setMyLanguage).not.toHaveBeenCalled();
  });

  it("signed in, saves it for the session's own person (no user id passed)", async () => {
    readSession.mockResolvedValue({ hermesToken: "tok-amy" });
    setMyLanguage.mockResolvedValue({ language: "zh-Hant" });
    const res = await post({ language: "zh-Hant", user_id: "ben" });
    expect(await res.json()).toEqual({ language: "zh-Hant", saved: true });
    expect(constructed).toEqual([{ hermesToken: "tok-amy" }]);
    expect(setMyLanguage).toHaveBeenCalledWith("zh-Hant");
  });

  it("reports a failed save but keeps the browser copy", async () => {
    readSession.mockResolvedValue({ hermesToken: "tok" });
    setMyLanguage.mockRejectedValue(new Error("down"));
    const res = await post({ language: "en" });
    expect(res.status).toBe(502);
    expect(jar.get("aq_lang")).toBe("en");
  });
});

describe("syncLanguageAtLogin", () => {
  it("the person's saved language wins over this browser's", async () => {
    jar.set("aq_lang", "en");
    const api = { myPreferences: vi.fn(async () => ({ language: "zh-Hant" })), setMyLanguage: vi.fn() };
    expect(await syncLanguageAtLogin(api)).toBe("zh-Hant");
    expect(jar.get("aq_lang")).toBe("zh-Hant");
    expect(api.setMyLanguage).not.toHaveBeenCalled();
  });

  it("someone who never chose keeps the login-page choice, now saved for them", async () => {
    jar.set("aq_lang", "zh-Hant");
    const api = {
      myPreferences: vi.fn(async () => ({ language: null })),
      setMyLanguage: vi.fn(async (language: string) => ({ language })),
    };
    expect(await syncLanguageAtLogin(api)).toBe("zh-Hant");
    expect(api.setMyLanguage).toHaveBeenCalledWith("zh-Hant");
  });

  it("never blocks sign-in when the API is unavailable", async () => {
    const api = { myPreferences: vi.fn(async () => Promise.reject(new Error("x"))), setMyLanguage: vi.fn() };
    expect(await syncLanguageAtLogin(api)).toBeNull();
  });
});
