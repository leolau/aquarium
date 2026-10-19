import { createTranslator, type TranslateVars } from "@/i18n/translate";
import type { Locale } from "@/i18n/config";
import en from "@/i18n/messages/en/getReady.json";
import zhHant from "@/i18n/messages/zh-Hant/getReady.json";

export { useLocale, useT } from "@/i18n";
export type T = (key: string, params?: TranslateVars) => string;

/** Outside React (tests): the same lookup `useT("getReady")` does. */
export function translate(locale: Locale, key: string, params?: TranslateVars): string {
  const strings = locale === "zh-Hant" ? { ...en, ...zhHant } : en;
  return createTranslator({ getReady: strings }, "getReady")(key, params);
}

export function formatWhen(locale: Locale, iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale === "zh-Hant" ? "zh-Hant-HK" : "en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
