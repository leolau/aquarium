import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  GET_READY_PATH,
  SETUP_LINK_INVALID,
  SETUP_PROVIDERS,
  SetupOwnerForm,
  passwordStrength,
  setupFormError,
  tokenFromHash,
} from "@/components/auth/SetupOwnerForm";
import { localeFromBrowser, setupT } from "@/components/auth/setupI18n";
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
  it("has every English key in Traditional Chinese", () => {
    expect(Object.keys(zhHant).sort()).toEqual(Object.keys(en).sort());
  });
  it("fills placeholders and switches language", () => {
    expect(setupT("en", "s3_ok", { seconds: "1.2" })).toContain("1.2 s");
    expect(setupT("zh-Hant", "finish")).toBe("完成設定");
    expect(localeFromBrowser(["zh-HK", "en"])).toBe("zh-Hant");
    expect(localeFromBrowser(["en-GB"])).toBe("en");
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
