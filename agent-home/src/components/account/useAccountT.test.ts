import { describe, expect, it } from "vitest";

import en from "@/i18n/messages/en/account.json";
import zhHant from "@/i18n/messages/zh-Hant/account.json";

import { pickLocale, translate } from "./useAccountT";

describe("account strings", () => {
  it("has every English key in Traditional Chinese", () => {
    expect(Object.keys(zhHant).sort()).toEqual(Object.keys(en).sort());
  });

  it("fills placeholders", () => {
    expect(translate("en", "codesLeft", { n: 8 })).toBe("8 recovery codes left");
    expect(translate("zh-Hant", "codesLeft", { n: 8 })).toBe("尚餘 8 個備用碼");
  });

  it("picks zh-Hant only for Traditional Chinese browsers", () => {
    expect(pickLocale(["zh-HK"])).toBe("zh-Hant");
    expect(pickLocale(["zh-Hant-TW"])).toBe("zh-Hant");
    expect(pickLocale(["zh-CN"])).toBe("en");
    expect(pickLocale(["en-GB"])).toBe("en");
    expect(pickLocale([])).toBe("en");
  });
});
