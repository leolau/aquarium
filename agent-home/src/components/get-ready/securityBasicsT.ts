/**
 * Strings for Security basics, from src/i18n/messages/<lang>/securityBasics.json.
 * Tiny local reader until the shared `useT()` hook lands in src/i18n; the
 * language follows <html lang> ("zh…" = Traditional Chinese).
 */
import { useCallback, useSyncExternalStore } from "react";

import en from "@/i18n/messages/en/securityBasics.json";
import zhHant from "@/i18n/messages/zh-Hant/securityBasics.json";

export type Lang = "en" | "zh-Hant";
export type SecurityBasicsKey = keyof typeof en;
export type Translate = (key: SecurityBasicsKey, vars?: Record<string, string | number>) => string;

const MESSAGES: Record<Lang, Record<string, string>> = { en, "zh-Hant": zhHant };

export function pickLang(raw?: string | null): Lang {
  return raw && raw.toLowerCase().startsWith("zh") ? "zh-Hant" : "en";
}

export function translate(
  lang: Lang,
  key: SecurityBasicsKey,
  vars: Record<string, string | number> = {},
): string {
  const text = MESSAGES[lang][key] ?? en[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (all, name: string) =>
    name in vars ? String(vars[name]) : all,
  );
}

const noSubscribe = () => () => {};

export function useSecurityBasicsT(lang?: Lang): { t: Translate; lang: Lang } {
  const fromPage = useSyncExternalStore(
    noSubscribe,
    () => pickLang(document.documentElement.lang),
    () => "en" as Lang,
  );
  const current = lang ?? fromPage;
  const t = useCallback<Translate>((key, vars) => translate(current, key, vars), [current]);
  return { t, lang: current };
}
