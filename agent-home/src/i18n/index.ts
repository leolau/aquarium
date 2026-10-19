// Client-safe entry. Server components use `getT` from "@/i18n/server".
export { I18nProvider, useLocale, useT } from "@/i18n/client";
export {
  DEFAULT_LOCALE,
  htmlLang,
  isLocale,
  LOCALE_COOKIE,
  LOCALE_LABELS,
  LOCALES,
  type Locale,
} from "@/i18n/config";
export type { Translator, TranslateVars } from "@/i18n/translate";
