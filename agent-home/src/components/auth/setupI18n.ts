/**
 * Local string lookup for the first-run /setup page.
 *
 * Strings live in the shared i18n message files
 * (`src/i18n/messages/<locale>/setup.json`) so the i18n unit's `useT("setup")`
 * can take over without moving them. The page switches language live, so the
 * locale is a prop here rather than read from a provider.
 */
import en from "@/i18n/messages/en/setup.json";
import zhHant from "@/i18n/messages/zh-Hant/setup.json";

export type SetupLocale = "en" | "zh-Hant";
export type SetupKey = keyof typeof en;

const MESSAGES: Record<SetupLocale, Record<SetupKey, string>> = { en, "zh-Hant": zhHant };

export function setupT(
  locale: SetupLocale,
  key: SetupKey,
  vars: Record<string, string | number> = {},
): string {
  const text = MESSAGES[locale][key] ?? MESSAGES.en[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

/** The browser's language, mapped onto the two the page offers. */
export function localeFromBrowser(languages: readonly string[]): SetupLocale {
  return languages.some((lang) => /^zh(-(hant|tw|hk|mo))?$/i.test(lang) || /^zh-hant/i.test(lang))
    ? "zh-Hant"
    : "en";
}
