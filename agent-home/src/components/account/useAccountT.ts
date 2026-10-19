"use client";

/**
 * Typed reader for the `account` strings; the language comes from the shared
 * `useT` hook (the person's saved choice), not the browser.
 */
import { useT } from "@/i18n";

import en from "@/i18n/messages/en/account.json";
import zhHant from "@/i18n/messages/zh-Hant/account.json";

export type AccountKey = keyof typeof en;
export type AccountT = (key: AccountKey, vars?: Record<string, string | number>) => string;

const MESSAGES: Record<"en" | "zh-Hant", Record<AccountKey, string>> = { en, "zh-Hant": zhHant };

export function pickLocale(langs: readonly string[]): "en" | "zh-Hant" {
  const first = (langs[0] ?? "").toLowerCase();
  return /^zh-(hant|tw|hk|mo)/.test(first) ? "zh-Hant" : "en";
}

export function translate(
  locale: "en" | "zh-Hant",
  key: AccountKey,
  vars: Record<string, string | number> = {},
): string {
  const text = MESSAGES[locale][key] ?? en[key];
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

export function useAccountT(): AccountT {
  return useT("account") as AccountT;
}
