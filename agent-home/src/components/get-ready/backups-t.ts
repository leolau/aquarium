/**
 * Strings for Get ready → Backups, read from the shared i18n message files
 * (`src/i18n/messages/<lang>/backups.json`). Tiny local reader until the
 * shared `useT()` hook lands; swap `backupsT(lang)` for `useT("backups")`.
 */
import en from "@/i18n/messages/en/backups.json";
import zhHant from "@/i18n/messages/zh-Hant/backups.json";

export type BackupsKey = keyof typeof en;
export type BackupsLang = "en" | "zh-Hant";
export type BackupsT = (key: BackupsKey, vars?: Record<string, string | number>) => string;

const MESSAGES: Record<BackupsLang, Record<BackupsKey, string>> = { en, "zh-Hant": zhHant };

/** The page language: zh-Hant for any Chinese `<html lang>`, else English. */
export function pageLang(): BackupsLang {
  if (typeof document === "undefined") return "en";
  return document.documentElement.lang.toLowerCase().startsWith("zh") ? "zh-Hant" : "en";
}

export function backupsT(lang: BackupsLang = "en"): BackupsT {
  const table = MESSAGES[lang] ?? en;
  return (key, vars) =>
    (table[key] ?? en[key] ?? key).replace(/\{(\w+)\}/g, (all, name: string) =>
      vars && name in vars ? String(vars[name]) : all,
    );
}
