import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  GET_READY_PATH,
  SETUP_LINK_INVALID,
  SETUP_PROVIDERS,
  SetupOwnerForm,
  ownerLoginProvider,
  passwordStrength,
  setupFormError,
  tokenFromHash,
} from "@/components/auth/SetupOwnerForm";
import { createTranslator } from "@/i18n/translate";
import en from "@/i18n/messages/en/setup.json";
import zhHant from "@/i18n/messages/zh-Hant/setup.json";

describe("tokenFromHash", () => {
  it("reads the token from the fragment hermes setup-link prints", () => {
    expect(tokenFromHash("#token=Qm9-abc_123")).toBe("Qm9-abc_123");
    expect(tokenFromHash("token=xyz")).toBe("xyz");
  });

  it("returns empty for a missing or empty token", () => {
    expect(tokenFromHash("")).toBe("");
    expect(tokenFromHash("#")).toBe("");
    expect(tokenFromHash("#token=")).toBe("");
    expect(tokenFromHash("#other=1")).toBe("");
  });
});

describe("setupFormError", () => {
  const good = "correct horse battery";
  it("accepts a valid email and matching 12+ character passwords", () => {
    expect(setupFormError("owner@example.com", good, good)).toBeNull();
  });
  it("rejects a bad email, a short password and a mismatch", () => {
    expect(setupFormError("owner", good, good)).toMatch(/email/);
    expect(setupFormError("owner@example.com", "short", "short")).toMatch(/12/);
    expect(setupFormError("owner@example.com", good, `${good}!`)).toMatch(/match/);
  });
});

describe("SetupOwnerForm", () => {
  it("starts by checking the link and never renders a token", () => {
    const html = renderToStaticMarkup(<SetupOwnerForm />);
    expect(html).toContain('data-component="SetupChecking"');
    expect(html).not.toContain("token=");
  });

  it("tells the reader how to get a new link", () => {
    expect(SETUP_LINK_INVALID).toContain("hermes setup-link");
  });
});

describe("passwordStrength", () => {
  it("is 'too short' under the 12-character server minimum", () => {
    expect(passwordStrength("")).toBe(0);
    expect(passwordStrength("Abc123!x")).toBe(0);
  });
  it("grows with length and mixed characters", () => {
    expect(passwordStrength("abcdefghijkl")).toBe(1);
    expect(passwordStrength("abcdefghijklmnop")).toBe(2);
    expect(passwordStrength("Blue tram to Central at 8")).toBe(3);
  });
});

describe("setup strings", () => {
  it("words form problems in the page's language", () => {
    const zh = createTranslator({ setup: zhHant }, "setup");
    expect(setupFormError("owner@example.com", "short", "short", zh)).toContain("12");
    expect(setupFormError("owner", "x", "x", zh)).toBe(zhHant.errorEmail);
  });
  it("has a label for every provider and step-status the page shows", () => {
    const t = createTranslator({ setup: en }, "setup");
    for (const p of SETUP_PROVIDERS) expect(t.has(p.label)).toBe(true);
    for (const k of ["st0", "st1", "st2", "st3", "r1", "r2", "r3", "r4", "r5"]) expect(t.has(k)).toBe(true);
  });
});

describe("ownerLoginProvider", () => {
  it("signs the new owner into the password login, GoTrue first", () => {
    expect(ownerLoginProvider([{ name: "basic", supports_password: true }, { name: "supabase", supports_password: true }])).toBe("supabase");
    expect(ownerLoginProvider([{ name: "google", supports_password: false }])).toBe("");
  });
});

describe("setup flow constants", () => {
  it("finishes on Settings → Get ready and offers the five mockup providers", () => {
    expect(GET_READY_PATH).toBe("/settings/get-ready");
    expect(SETUP_PROVIDERS.map((p) => p.id)).toEqual([
      "openrouter", "anthropic", "openai-api", "deepseek", "gemini",
    ]);
  });
});
