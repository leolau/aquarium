/** Languages agent-home ships strings for. English is the default. */
export const LOCALES = ["en", "zh-Hant"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

/** Browser copy of the language: the choice before sign-in, and a cache of
 *  the person's saved setting after it. The server-side setting wins at login. */
export const LOCALE_COOKIE = "aq_lang";

/** Switcher labels — each written in its own language. */
export const LOCALE_LABELS: Record<Locale, string> = {
  en: "EN",
  "zh-Hant": "繁體中文",
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** The `<html lang>` value: Traditional Chinese as written in Hong Kong. */
export function htmlLang(locale: Locale): string {
  return locale === "zh-Hant" ? "zh-Hant-HK" : "en";
}
