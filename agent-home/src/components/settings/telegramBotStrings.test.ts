import { describe, expect, it } from "vitest";

import en from "@/i18n/messages/en/telegramBot.json";
import zhHant from "@/i18n/messages/zh-Hant/telegramBot.json";
import { errorKey, pickLocale, translate } from "@/components/settings/telegramBotStrings";

describe("telegramBot strings", () => {
  it("has the same keys in English and Traditional Chinese", () => {
    expect(Object.keys(zhHant).sort()).toEqual(Object.keys(en).sort());
  });

  it("picks zh-Hant for Chinese pages and fills placeholders", () => {
    expect(pickLocale("zh-HK")).toBe("zh-Hant");
    expect(pickLocale("en-GB")).toBe("en");
    expect(translate("en", "linked", { who: "@leo" })).toContain("@leo");
  });

  it("maps Hermes error codes to plain messages", () => {
    expect(errorKey("bot_in_use")).toBe("err_bot_in_use");
    expect(errorKey("Hermes API 409: telegram_account_in_use")).toBe("err_telegram_account_in_use");
    expect(errorKey("boom")).toBe("err_generic");
  });
});
