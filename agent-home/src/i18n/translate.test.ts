import { describe, expect, it } from "vitest";

import { htmlLang, isLocale } from "@/i18n/config";
import { loadMessages } from "@/i18n/load";
import { createTranslator, mergeTrees } from "@/i18n/translate";

describe("createTranslator", () => {
  const messages = { demo: { hello: "Hi {name}", deep: { key: "Deep" } } };

  it("reads dotted keys and fills placeholders", () => {
    const t = createTranslator(messages, "demo");
    expect(t("hello", { name: "Amy" })).toBe("Hi Amy");
    expect(t("deep.key")).toBe("Deep");
    expect(t.has("deep.key")).toBe(true);
  });

  it("shows the key for a missing string instead of a blank", () => {
    const t = createTranslator(messages, "demo");
    expect(t("nope")).toBe("demo.nope");
    expect(t.has("nope")).toBe(false);
    expect(createTranslator(messages, "absent")("x")).toBe("absent.x");
  });

  it("falls back to English for a string a locale lacks", () => {
    expect(mergeTrees({ a: "A", b: "B" }, { a: "甲" })).toEqual({ a: "甲", b: "B" });
  });
});

describe("locales", () => {
  it("defaults to English and maps zh-Hant to Hong Kong for <html lang>", () => {
    expect(isLocale("en")).toBe(true);
    expect(isLocale("fr")).toBe(false);
    expect(htmlLang("en")).toBe("en");
    expect(htmlLang("zh-Hant")).toBe("zh-Hant-HK");
  });

  it("loads the real message files for both languages", () => {
    expect(createTranslator(loadMessages("en"), "login")("signIn")).toBe("Sign in");
    expect(createTranslator(loadMessages("zh-Hant"), "login")("signIn")).toBe("登入");
  });
});
